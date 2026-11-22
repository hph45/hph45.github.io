"""Refine sparse public book metadata using exact title/author search evidence."""
import argparse,collections,json
from pathlib import Path
from prepare import PublicMetadata,article_key,key,enrich,digest,write

def exact_candidate(book,candidate):
    return (key(book['author']) not in ('','unknown','unknownauthor')
            and article_key(book['title'])==article_key(candidate.get('title',''))
            and any(key(a)==key(book['author']) for a in candidate.get('author_name',[])))

def main(directory,limit):
    directory=Path(directory);books=json.loads((directory/'books.json').read_text());aliases=json.loads((directory/'aliases.json').read_text())
    snapshot=json.loads((directory/'snapshot.json').read_text());diagnosis=json.loads((directory/'unmatched-diagnosis.json').read_text())
    targets={r['user_id'] for r in diagnosis if r['eligible_candidates']};frequency=collections.Counter()
    for p in snapshot['profiles']:
        if p['user_id'] in targets:
            for b in p['favorites']:
                bid=aliases[b['id']]
                if not books[bid]['metadata_adequate'] and key(books[bid]['author']) not in ('','unknown','unknownauthor'):frequency[bid]+=1
    loader=PublicMetadata(directory.parent/'book-metadata');cache=directory.parent/'metadata-refinements';cache.mkdir(exist_ok=True)
    results=[]
    for bid,_ in sorted(frequency.items(),key=lambda x:(-x[1],x[0]))[:limit]:
        book=books[bid];path=cache/(bid+'.json');result=None
        if path.exists():result=json.loads(path.read_text())
        else:
            result={'book_id':bid,'title':book['title'],'author':book['author'],'status':'no_exact_adequate_alternative'}
            try:
                query={'title':book['title'],'author':book['author'],'fields':'key,title,author_name','limit':20}
                search=loader.get('https://openlibrary.org/search.json',query)
                candidates=sorted((c for c in search.get('docs',[]) if exact_candidate(book,c)),key=lambda c:c['key'])
                for candidate in candidates[:6]:
                    work=candidate['key'].split('/')[-1];meta=loader.one({**book,'id':work})
                    if meta.get('status')!='found' or article_key(meta.get('source_title',''))!=article_key(book['title']):continue
                    raw={k:book[k] for k in ('id','title','author','source_ids','frequency')};refined=enrich(raw,meta)
                    if not refined['metadata_adequate']:continue
                    refined['metadata']={**meta,'book_id':bid,'resolution':'exact_title_and_author_search_refinement',
                                         'search_url':'https://openlibrary.org/search.json','search_parameters':query,
                                         'search_evidence':candidate,'search_response_sha256':digest(search)}
                    result.update(status='refined',refined_book=refined);break
            except Exception as exc:result.update(status='error',error=type(exc).__name__+': '+str(exc)[:200])
            write(path,result)
        if result['status']=='refined':
            raw={k:book[k] for k in ('id','title','author','source_ids','frequency')}
            books[bid]={**result['refined_book'],**raw}
        results.append(result);print(json.dumps({'processed':len(results),'title':book['title'],'status':result['status']}),flush=True)
    write(directory/'books.json',books);write(directory/'metadata-refinement.json',results)
    print(json.dumps({'statuses':dict(collections.Counter(r['status'] for r in results))}),flush=True)

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('run_dir');ap.add_argument('--limit',type=int,default=60);args=ap.parse_args();main(args.run_dir,args.limit)
