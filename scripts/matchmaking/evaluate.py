"""Descriptive checks and ablations; feedback is not used to fit the scoring rules."""
import argparse,collections,json,math,statistics
from pathlib import Path
from scipy.stats import spearmanr
from engine import Matcher
from prepare import write

def evaluate(directory):
    directory=Path(directory);m=Matcher(directory);snap=m.snapshot;plan=json.loads((directory/'plan.json').read_text())
    test={r['user_id'] for r in snap['review_accounts']};history={r['id']:r for r in snap['matches']};records=[]
    raw_feedback={}
    for kind in ('romance','friends','business_partners'):
        rs=[r for r in snap['reviews'] if r['user_id'] not in test and history.get(r['match_id'],{}).get('intent')==kind]
        if rs:raw_feedback[kind]={'n':len(rs),'rating_distribution':dict(sorted(collections.Counter(r['compatibility_rating'] for r in rs).items())),
                                  'compatibility_average':round(statistics.mean(r['compatibility_rating'] for r in rs),3)}
    for review in snap['reviews']:
        h=history.get(review['match_id']);ids=[r['user_id'] for r in h.get('members') or []] if h else []
        if review['user_id'] in test or len(ids)!=2 or not all(u in m.shelves for u in ids):continue
        fit,evidence=m.book_fit(*ids)
        records.append({'type':h['intent'],'rating':review['compatibility_rating'],'book_rating':review['book_rating'],
                        'book_fit':fit,'embedding_only':evidence['semantic'],'baseline':evidence['baseline']})
    feedback={}
    for kind in ('romance','friends','business_partners'):
        rs=[r for r in records if r['type']==kind]
        if not rs:continue
        feedback[kind]={'n':len(rs),'compatibility_average':round(statistics.mean(r['rating'] for r in rs),3),
                        'rating_distribution':dict(sorted(collections.Counter(r['rating'] for r in rs).items()))}
        for field in ('book_fit','embedding_only','baseline'):
            correlation=spearmanr([r[field] for r in rs],[r['rating'] for r in rs]).statistic if len(rs)>2 else None
            feedback[kind][field+'_rating_spearman']=float(correlation) if correlation is not None and math.isfinite(correlation) else None
    coverage=collections.Counter()
    for p in m.active:
        flags=[m.books[b]['metadata_adequate'] for b in m.shelves[p['user_id']]]
        coverage['all_favorites_enriched' if all(flags) else 'some_favorites_enriched' if any(flags) else 'no_favorites_enriched']+=1
    # Candidate retention sensitivity is not presented as re-optimized allocation.
    sensitivity={delta:collections.Counter() for delta in (-.05,0.,.05)}
    near=0;above_baseline=0
    for line in (directory/'embeddings-candidates.jsonl').open():
        e=json.loads(line)
        for delta,counter in sensitivity.items():
            if e['score']>=e['threshold']+delta:counter[e['type']]+=1
    for e in plan['matches']:
        near+=e['score']-e['threshold']<.05
        above_baseline+=e['book_fit']>e['book_evidence']['baseline']+.05
    distribution={kind:dict(collections.Counter(round(e['score'],1) for e in plan['matches'] if e['type']==kind)) for kind in ('romance','friends','business_partners')}
    result={'all_recorded_feedback':raw_feedback,'feedback_sample':feedback,'feedback_records_used':len(records),'metadata_coverage':dict(coverage),
            'selected_pairs_within_5_points_of_cutoff':near,'selected_pairs_with_book_fit_above_exact_baseline':above_baseline,
            'selected_score_distribution':distribution,
            'existing_candidate_retention_at_higher_cutoff':{str(d):dict(c) for d,c in sensitivity.items() if d>=0},
            'limitations':['Sparse, voluntary, one-sided reviews; associations are descriptive, not causal or calibrated predictions.',
                          'Current profiles may differ from those at the first-round release; this is a diagnostic, not a historical replay.',
                          'Candidate-retention sensitivity does not estimate final coverage at a new threshold.',
                          'Book similarity cannot establish attraction or unrecorded personal requirements.']}
    baseline_path=directory/'baseline-plan.json'
    if baseline_path.exists():
        baseline=json.loads(baseline_path.read_text())
        result['exact_title_author_ablation']={'pairs':baseline['summary']['pairs'],'by_type':baseline['summary']['by_type'],
            'note':'Same constraints and numeric cutoffs, with semantic and genre evidence removed. Coverage difference does not establish better outcomes.'}
    write(directory/'evaluation.json',result);print(json.dumps(result))

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('run_dir');evaluate(ap.parse_args().run_dir)
