"""Fill uncached work subjects in batches; direct work descriptions take precedence."""
import argparse, hashlib, json, re, time
from pathlib import Path
from prepare import PublicMetadata, collect, digest, write

ap=argparse.ArgumentParser();ap.add_argument('run_dir',type=Path);args=ap.parse_args()
snapshot=json.loads((args.run_dir/'snapshot.json').read_text());books,_=collect(snapshot)
cache=args.run_dir.parent/'book-metadata';service=PublicMetadata(cache)
# Leave the direct fetcher's leading books to obtain their descriptions.
ordered=sorted(books.values(),key=lambda b:(-b['frequency'],b['id']))
remaining=[b['id'] for b in ordered if re.fullmatch(r'OL\d+W',b['id']) and not (cache/(b['id']+'.json')).exists()][100:]
for offset in range(0,len(remaining),35):
    batch=[i for i in remaining[offset:offset+35] if not (cache/(i+'.json')).exists()]
    if not batch:continue
    try:
        data=service.get('https://openlibrary.org/search.json',{'q':'key:('+ ' OR '.join('/works/'+i for i in batch)+')',
            'fields':'key,title,author_name,subject','limit':len(batch)})
        found=0
        for doc in data.get('docs',[]):
            bid=doc.get('key','').split('/')[-1];path=cache/(bid+'.json')
            if bid not in batch or path.exists():continue
            result={'book_id':bid,'source_url':'https://openlibrary.org/works/'+bid,
                    'source_work_id':bid,'source_title':doc.get('title',''),'status':'found',
                    'subjects':doc.get('subject',[]),'description':'','source_sha256':digest(doc),
                    'source_method':'batched_search_work_subjects'}
            write(path,result);found+=1
        print(json.dumps({'batch_offset':offset,'target':len(remaining),'cached':found}),flush=True)
    except Exception as exc:print(json.dumps({'batch_error':str(exc)[:180]}),flush=True)
    # Combined with the direct fetcher this stays below three requests/second.
    time.sleep(5)
