"""Cache public book metadata and fixed local embeddings. Never sends member text."""
from __future__ import annotations
import argparse, collections, concurrent.futures, hashlib, json, os, re, threading, time, unicodedata
from pathlib import Path

def key(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value or '').casefold()
                   if c.isalnum() and not unicodedata.combining(c))

def article_key(value):return key(re.sub(r'^(?:the|a|an)\s+','',value or '',flags=re.I))

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def write(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2)); tmp.replace(path)

def collect(snapshot):
    catalog = {b['work_id']: {'id':b['work_id'], 'title':b['title'], 'author':b['author']} for b in snapshot['books']}
    needed = collections.Counter()
    for p in snapshot['profiles']:
        if not p['is_active']: continue
        for b in p['favorites'] + ([p['currently_reading']] if p['currently_reading'] else []):
            catalog.setdefault(b['id'], b); needed[b['id']] += 1
    for m in snapshot['matches']:
        if m.get('recommended_book_id'): needed[m['recommended_book_id']] += 0
    for b in snapshot['library']: needed[b['work_id']] += 0
    by_name = collections.defaultdict(list)
    for b in catalog.values(): by_name[(key(b['title']), key(b['author']))].append(b['id'])
    aliases, books = {}, {}
    for original in sorted(needed):
        b = catalog[original]; candidates = by_name[(key(b['title']), key(b['author']))]
        canonical = min(candidates, key=lambda x:(not bool(re.fullmatch(r'OL\d+W',x)), -needed.get(x,0), x))
        aliases[original] = canonical
        if canonical not in books: books[canonical] = {**catalog[canonical], 'source_ids':[], 'frequency':0}
        books[canonical]['source_ids'].append(original); books[canonical]['frequency'] += needed[original]
    overrides=Path(__file__).with_name('book_identity_overrides.json')
    if overrides.exists():
        for row in json.loads(overrides.read_text())['overrides']:
            source=aliases.get(row['source_id'],row['source_id']);target=aliases.get(row['target_id'],row['target_id'])
            if source==target or source not in books:continue
            if target not in books:
                if target not in catalog:continue
                books[target]={**catalog[target],'source_ids':[],'frequency':0}
            a,b=books[source],books[target]
            if key(a['author'])!=key(b['author']) or article_key(a['title'])!=article_key(b['title']):
                raise ValueError('A reviewed duplicate changed and needs bibliographic reassessment: '+source)
            b['source_ids']=sorted(set(b['source_ids']+a['source_ids']));b['frequency']+=a['frequency']
            for original in list(aliases):
                if aliases[original]==source:aliases[original]=target
            del books[source]
    return books, aliases

class PublicMetadata:
    def __init__(self, cache):
        import requests
        self.requests = requests; self.cache = Path(cache); self.cache.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock(); self.next_at = 0
    def get(self, url, params=None):
        for attempt in range(3):
            with self.lock:
                delay=max(0,self.next_at-time.monotonic()); self.next_at=max(self.next_at,time.monotonic())+.55
            if delay: time.sleep(delay)
            try:
                r=self.requests.get(url,params=params,timeout=25,headers={'User-Agent':'ZebraBookClub-Metadata/1.0 (https://zebrabookclub.com; book metadata cache)'})
                r.raise_for_status(); return r.json()
            except self.requests.RequestException:
                if attempt==2: raise
                time.sleep(2**attempt)
    def one(self, book):
        path=self.cache/(book['id']+'.json')
        if path.exists(): return json.loads(path.read_text())
        result={'book_id':book['id'],'source_url':None,'status':'missing','subjects':[],'description':''}
        try:
            work=book['id'] if re.fullmatch(r'OL\d+W',book['id']) else None
            if not work:
                data=self.get('https://openlibrary.org/search.json',{'title':book['title'],'author':book['author'],'fields':'key,title,author_name,subject','limit':5})
                for candidate in data.get('docs',[]):
                    authors=candidate.get('author_name',[])
                    if key(candidate.get('title',''))==key(book['title']) and any(key(a)==key(book['author']) for a in authors):
                        work=candidate['key'].split('/')[-1]; result['resolution']='exact_title_and_author'; break
            if work:
                url='https://openlibrary.org/works/'+work+'.json'; data=self.get(url)
                if data.get('type',{}).get('key')=='/type/redirect':
                    target=data.get('location','')
                    if re.fullmatch(r'/works/OL\d+W',target):
                        url='https://openlibrary.org'+target+'.json'; data=self.get(url)
                description=data.get('description','')
                if isinstance(description,dict): description=description.get('value','')
                result.update(source_url=url,source_work_id=data.get('key','').split('/')[-1],
                              source_title=data.get('title',''),subjects=data.get('subjects',[]),
                              description=str(description or '')[:8000],status='found')
                result['source_sha256']=digest(data)
        except Exception as exc:
            result.update(status='error',error=type(exc).__name__+': '+str(exc)[:200])
        write(path,result); return result

SUBJECT_NOISE=re.compile(r'^(?:fiction|general|accessible book|protected daisy|in library|large type books|large print|translations|juvenile fiction|lending library)$|^(?:nyt:|nyt |bestseller|award|reading level|open syllabus|overdrive)',re.I)
GENRES={
 'fantasy':r'\bfantasy\b|magic realism', 'science fiction':r'science fiction|dystopia|space opera',
 'mystery':r'mystery|detective|crime fiction|thriller', 'romance':r'\bromance\b(?! languages)|romantic fiction',
 'historical fiction':r'historical fiction|historical novels', 'literary fiction':r'literary fiction|fiction / literary',
 'memoir and biography':r'memoir|biograph', 'poetry':r'\bpoetry\b|\bpoems\b',
 'philosophy':r'philosoph', 'psychology':r'psycholog', 'personal development':r'self.help|personal growth|self.improvement',
 'business':r'business|entrepreneur|management|leadership', 'science':r'popular science|science /|physics|biology',
 'history':r'\bhistory\b', 'politics and society':r'politic|sociolog|social conditions',
 'nature':r'nature writing|natural history|environment|ecology',
 'horror':r'\bhorror\b|ghost stories|gothic fiction', 'classics':r'\bclassics\b|classic literature',
}
def enrich(book, meta):
    subjects=[]
    for s in meta.get('subjects',[]):
        if isinstance(s,str) and len(s)<110 and not SUBJECT_NOISE.search(s) and s.casefold() not in {x.casefold() for x in subjects}:
            subjects.append(s)
    subjects=subjects[:35]
    description=re.sub(r'\[[^]]*\]\([^)]*\)','',meta.get('description',''))
    description=re.sub(r'https?://\S+','',description)
    description=re.sub(r'\s+',' ',description).strip()[:1400]
    joined='; '.join(subjects)
    genres=sorted(g for g,pattern in GENRES.items() if re.search(pattern,joined,re.I))
    adequate=len(description)>=70 or len(subjects)>=2
    text=f"{book['title']} by {book['author']}. "
    if description: text+=description+' '
    if subjects: text+='Subjects: '+', '.join(subjects[:20])+'.'
    return {**book,'metadata':meta,'subjects':subjects,'genres':genres,
            'metadata_adequate':adequate,'embedding_text':text,'text_sha256':hashlib.sha256(text.encode()).hexdigest()}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('run_dir',type=Path)
    ap.add_argument('--stage',choices=['metadata','cached','model','embeddings','all'],default='all')
    ap.add_argument('--workers',type=int,default=4); args=ap.parse_args()
    private=args.run_dir.parent; snapshot=json.loads((args.run_dir/'snapshot.json').read_text())
    books,aliases=collect(snapshot)
    write(args.run_dir/'aliases.json',aliases)
    if args.stage=='cached':
        results={}
        for bid,b in books.items():
            path=private/'book-metadata'/(bid+'.json')
            if not path.exists():raise RuntimeError('Metadata has not completed for '+bid)
            results[bid]=enrich(b,json.loads(path.read_text()))
        write(args.run_dir/'books.json',{k:results[k] for k in sorted(results)})
        print(json.dumps({'cached_books':len(results),'adequate':sum(x['metadata_adequate'] for x in results.values())}),flush=True)
    if args.stage in ('all','metadata'):
        service=PublicMetadata(private/'book-metadata'); results={}; ordered=sorted(books.values(),key=lambda b:(-b['frequency'],b['id']))
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs={pool.submit(service.one,b):b for b in ordered}
            for i,future in enumerate(concurrent.futures.as_completed(jobs),1):
                b=jobs[future]; results[b['id']]=enrich(b,future.result())
                if i%100==0 or i==len(ordered): print(json.dumps({'metadata_done':i,'total':len(ordered),'adequate':sum(b['metadata_adequate'] for b in results.values())}),flush=True)
        write(args.run_dir/'books.json',{k:results[k] for k in sorted(results)})
        print(json.dumps({'metadata_status':dict(collections.Counter(b['metadata']['status'] for b in results.values()))}),flush=True)
    if args.stage in ('all','model','embeddings'):
        os.environ['HF_HOME']=str(private/'model-cache'); os.environ['TOKENIZERS_PARALLELISM']='false'
        import numpy as np, torch, requests
        from sentence_transformers import SentenceTransformer
        torch.set_num_threads(4); torch.manual_seed(0); torch.use_deterministic_algorithms(True)
        model_name='sentence-transformers/all-MiniLM-L6-v2'
        manifest_path=args.run_dir/'model.json'
        if manifest_path.exists(): revision=json.loads(manifest_path.read_text())['revision']
        else:
            response=requests.get('https://huggingface.co/api/models/'+model_name,timeout=30);response.raise_for_status();revision=response.json()['sha']
        model=SentenceTransformer(model_name,revision=revision,device='cpu',cache_folder=str(private/'model-cache'),
                                  local_files_only=args.stage=='embeddings' and manifest_path.exists())
        if args.stage=='model':
            write(manifest_path,{'name':model_name,'revision':revision});print('Model cached at pinned revision '+revision,flush=True);return
        books=json.loads((args.run_dir/'books.json').read_text()); ids=sorted(books)
        vectors=model.encode([books[i]['embedding_text'] for i in ids],batch_size=64,normalize_embeddings=True,show_progress_bar=True,convert_to_numpy=True)
        np.save(args.run_dir/'book-vectors.npy',vectors,allow_pickle=False)
        manifest={'name':model_name,'revision':revision,'dimension':int(vectors.shape[1]),'ids':ids,
                  'books_sha256':digest(books),'vectors_sha256':hashlib.sha256((args.run_dir/'book-vectors.npy').read_bytes()).hexdigest(),
                  'max_seq_length':model.max_seq_length,'device':'cpu','seed':0}
        write(manifest_path,manifest);print(json.dumps({'embedded_books':len(ids),'revision':revision}),flush=True)

if __name__=='__main__': main()
