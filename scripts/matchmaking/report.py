"""Produce a self-contained private review page. Never copy it into public assets."""
import argparse,collections,json,math
from pathlib import Path
from prepare import write

PAGE=r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Round two · Private review</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#f5f3ee;color:#242820;margin:0}main{max-width:1200px;margin:auto;padding:30px}h1{margin:0}h2{font-size:22px}h3{font-size:18px;margin:10px 0}p{margin:8px 0}.muted{color:#697063}.banner{background:#e7ecd9;padding:16px;border-radius:12px;margin:20px 0}.toolbar{display:flex;gap:12px;flex-wrap:wrap;position:sticky;top:0;background:#f5f3ee;padding:14px 0}input,select,button{font:inherit;padding:10px;border:1px solid #c7c9be;border-radius:8px;background:white}input{flex:1;min-width:220px}.card{background:white;border:1px solid #d7dacf;border-radius:12px;margin:15px 0;padding:22px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.fact{white-space:pre-wrap}.pill{display:inline-block;background:#edf0e6;border-radius:10px;padding:3px 9px;margin:3px}.warn{background:#fff0c7;border-left:4px solid #b88614;padding:12px}.book{background:#f6f5ef;padding:12px;border-radius:8px}summary{cursor:pointer}.table-scroll{overflow-x:auto}.small-button{font-size:14px;padding:6px 9px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}a{color:#355b2d}.controls{display:flex;gap:14px;align-items:center}@media(max-width:700px){.pair{grid-template-columns:1fr}main{padding:16px}}</style>
<main><p class="muted">ZEBRA BOOK CLUB · PRIVATE OPERATOR REVIEW</p><h1>Round two</h1><p id="subtitle"></p><div class="banner"><strong>Draft proposals — not released.</strong> Scores measure the configured introduction criteria, not a probability of romantic chemistry. Both people must have selected the connection type. Contact availability, written requirements, and missing-book holds shown below remain unresolved until reviewed.</div><div id="stats"></div><p id="coverage" class="fact"></p><p id="exceptions" class="fact"></p><p id="helper-summary" class="fact"></p>
<details><summary>Rules, audit, and reproducibility</summary><p id="method-note" class="fact"></p><pre id="method" style="white-space:pre-wrap"></pre></details>
<div class="toolbar"><input id="search" placeholder="Search names, cities, books, or pair ID"><select id="mode"><option value="matches">Proposed matches</option><option value="recipients">All recipient assignments</option><option value="helpers">Helpers with more than 3 introductions</option><option value="unintroduced">People with no introduction</option><option value="unmatched">Unmatched by selected type</option></select><select id="type"><option value="">All connection types</option><option value="romance">Romance</option><option value="friends">Friendship</option><option value="business_partners">Business</option></select><select id="status"><option value="">All statuses</option><option value="proposed">Proposed</option><option value="needs_contact_review">Contact review</option><option value="needs_boundary_review">Written requirement review</option><option value="needs_book_review">Book review</option></select><select id="tier"><option value="">All evidence tiers</option><option value="standard">Standard evidence</option><option value="broader_first_introduction">Broader evidence</option><option value="wider_age">Wider friendship age gap</option><option value="first_introduction_reading">First introduction reading evidence</option><option value="weak_first_introduction">Weak fit for a first introduction</option><option value="location_override">Owner-authorized location override</option><option value="second_intro">Extra introduction helping a first</option></select></div>
<p id="count" class="muted"></p><div id="list"></div><div class="controls"><button id="prev">Previous</button><span id="page"></span><button id="next">Next</button></div></main>
<script id="data" type="application/json">__DATA__</script><script>
const D=JSON.parse(document.querySelector('#data').textContent),$=s=>document.querySelector(s),people=D.people;let page=0;
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function paragraph(parent,label,value){if(!value)return;const p=el('p',undefined,'fact');p.append(el('strong',label+': '),document.createTextNode(value));parent.append(p)}
const isCover=D.plan.allocation_method==='edge_cover';
function names(ids){return ids.map(u=>people[u]?.name||u).join(' and ')}
function soleRecipients(m){return [m.a,m.b].filter(u=>D.coverage.introductions[u]===1)}
function weak(m){return m.quality_tier==='weak_first_introduction'||m.evidence_route==='coverage_first_weak_evidence'}
function witnesses(m){return D.coverage.extra_intro_witnesses?.[m.id]||D.coverage.second_intro_witnesses[m.id]||[]}
function person(id){
 const p=people[id],n=el('section');n.append(el('h3',p.name+', '+p.age));
 paragraph(n,'Location',[p.city,p.region,p.country].filter(Boolean).join(', '));paragraph(n,'Selected',(p.intents||[]).join(', '));paragraph(n,'Saved location preference',p.location_preference);
 const assignments=D.coverage.assignments[id]||[];
 if(assignments.length)paragraph(n,'Introductions in this draft',assignments.length+' total · '+Object.entries(D.coverage.recipient_by_type[id]||{}).map(([k,v])=>k+': '+v).join(', '));
 paragraph(n,'Favorite books',(p.favorites||[]).map(b=>b.title+' — '+b.author).join('\n'));
 if((p.intents||[]).includes('romance')){paragraph(n,'Romantic age range',p.age_min+'–'+p.age_max);paragraph(n,'Romance answer',p.romance_ideal_match)}
 paragraph(n,'Friendship answer',p.friendship_interests);paragraph(n,'Business idea',p.business_about);paragraph(n,'Skills offered',p.business_skills);paragraph(n,'Business needs',p.business_seeking);return n;
}
function match(m){
 const n=el('article',undefined,'card');const tier=weak(m)?'Weak fit for a first introduction':m.quality_tier==='first_introduction_reading'?'First introduction reading evidence':m.quality_tier==='standard'?'Standard evidence':'Broader evidence';
 const distance=Number.isFinite(m.distance_km)?Math.round(m.distance_km)+' km':'Distance unavailable';
 n.append(el('span',m.type,'pill'),el('span',m.status,'pill'),el('span','Fit '+Math.round(m.score*100)+'/100','pill'),el('span',distance,'pill'),el('span',tier,'pill'));
 if(m.owner_requested_pair)n.append(el('span','Member-requested pairing','pill'));
 if((m.contact_review_user_ids||[]).length)n.append(el('p','Contact hold for '+names(m.contact_review_user_ids)+': no consented contact route is currently available. This requested pairing is a private draft. Email sharing and Instagram settings have not changed; it is not cleared for release.','warn'));
 if(m.age_gap_years!==undefined)n.append(el('span','Age gap '+m.age_gap_years+' years','pill'));
 if((m.location_preference_exception_user_ids||[]).length)n.append(el('p','Owner-authorized location override for '+names(m.location_preference_exception_user_ids)+'. Their saved same-city preference has not changed. This pair is outside the same stored city or a verified metro pairing. Distance is shown for context and does not contribute to this run’s fit score.','warn'));
 if(m.friendship_age_gap_exception)n.append(el('p','Wider friendship age gap: '+m.age_gap_years+' years. This supplies the only introduction for '+names(soleRecipients(m))+'.','warn'));
 if(weak(m))n.append(el('p','Owner-authorized weak fit: the usual reading or activity evidence minimum was waived to provide a first introduction. This is the only introduction for '+names(soleRecipients(m))+'. The displayed score and explanation do not establish chemistry.','warn'));
 else if(m.first_introduction_rescue){const targets=(m.rescue_target_user_ids||[]).length?m.rescue_target_user_ids:[m.a,m.b];n.append(el('p','Reading evidence exception: '+(m.rescue_basis||[]).join(', ').replaceAll('_',' ')+'. This is the only introduction for '+names(targets.filter(u=>D.coverage.introductions[u]===1))+'.','warn'))}
 for(const w of witnesses(m))n.append(el('p',people[w.helper].name+' receives '+D.coverage.introductions[w.helper]+' introductions in this draft. This extra introduction gives '+people[w.recipient].name+' their only match.','warn'));
 const pair=el('div',undefined,'pair');pair.append(person(m.a),person(m.b));n.append(pair);n.append(el('h3','Introduction explanation'),el('p',m.member_reason));
 if(m.recommended_book){const b=m.recommended_book,box=el('div',undefined,'book');box.append(el('strong','Read together: '+b.title+' — '+b.author),el('p',b.reason));if(b.source_url&&b.source_url.startsWith('https://openlibrary.org/')){const a=el('a','Book metadata source');a.href=b.source_url;a.target='_blank';a.rel='noopener noreferrer';box.append(a)}n.append(box)}
 else n.append(el('p','Hold: no supported new shared book has been identified.','warn'));
 if(D.boundary_review[m.id])paragraph(n,'Review finding',D.boundary_review[m.id].note);
 if((m.written_boundary_flags||[]).length){const w=el('div',undefined,'warn');w.append(el('strong','Written requirements to review'));m.written_boundary_flags.forEach(f=>paragraph(w,people[f.user_id].name,f.answer));n.append(w)}
 const details=el('details');details.append(el('summary','Score evidence and alternatives'));details.append(el('pre',JSON.stringify({id:m.id,threshold:m.threshold,components:m.score_components,book_evidence:m.book_evidence,shared_activities:m.shared_activities,shared_genres:m.shared_genres,evidence_route:m.evidence_route,quality_tier:m.quality_tier,standard_threshold:m.standard_threshold,friendship_age_gap_exception:m.friendship_age_gap_exception,location_preference_exception_user_ids:m.location_preference_exception_user_ids,review_decision:m.review_decision,priority_people:m.priority_people,rescue_basis:m.rescue_basis,rescue_targets:m.rescue_target_user_ids,sole_recipient_user_ids:soleRecipients(m)},null,2),'fact'));n.append(details);return n;
}
function openPair(id){$('#mode').value='matches';$('#type').value='';$('#status').value='';$('#tier').value='';$('#search').value=id;page=0;render();window.scrollTo(0,0)}
function recipient(r){
 const n=el('article',undefined,'card');n.append(person(r.user_id));
 if(r.introduction_count>3)n.append(el('p','Helper load: '+r.introduction_count+' total introductions. All assignments are listed below.','warn'));
 paragraph(n,'Review state',r.held_only?'All proposals currently have a review hold.':'At least one proposal has no current review hold.');
 const box=el('div',undefined,'table-scroll'),table=el('table'),head=el('tr');['Connection','Counterpart','Status','Fit','Exceptions','Pair'].forEach(label=>head.append(el('th',label)));table.append(head);
 for(const a of r.assignments){const row=el('tr');const exceptions=[a.weak_first_introduction?'Weak fit':'',a.location_override?'Location override':'',a.wider_age?'Wider friendship age':''].filter(Boolean).join(', ');[a.type,people[a.other]?.name||a.other,a.status,Math.round(a.score*100)+'/100',exceptions||'None'].forEach(value=>row.append(el('td',value)));const cell=el('td'),button=el('button','Open pair','small-button');button.onclick=()=>openPair(a.pair_id);cell.append(button);row.append(cell);table.append(row)}box.append(table);n.append(box);return n;
}
function unmatched(r){const n=el('article',undefined,'card');n.append(el('span',r.type,'pill'),person(r.user_id));paragraph(n,'Reason',r.reason);paragraph(n,isCover?'Retained eligible candidates':'Candidates above threshold',String(r.candidate_count));const d=el('details');d.append(el('summary','Eligibility counts and alternatives'),el('pre',JSON.stringify({gates:r.gates,alternatives:(r.top_alternatives||[]).map(a=>({...a,other:people[a.other]?.name||a.other}))},null,2),'fact'));n.append(d);return n}
function unintroduced(r){const n=el('article',undefined,'card');n.append(person(r.user_id));paragraph(n,'Reason',r.reason);r.selections.forEach(x=>paragraph(n,x.type,x.reason+'; '+x.candidate_count+' qualifying candidates'));return n}
function render(){
 const mode=$('#mode').value,type=$('#type').value,status=$('#status').value,tier=$('#tier').value,q=$('#search').value.toLowerCase(),recipientMode=mode==='recipients'||mode==='helpers';
 let rows=recipientMode?D.coverage.recipients.filter(r=>mode!=='helpers'||r.introduction_count>3):mode==='unintroduced'?D.coverage.unintroduced:D.plan[mode];
 rows=rows.filter(r=>!type||(recipientMode?r.assignments.some(a=>a.type===type):mode==='unintroduced'?r.selections.some(x=>x.type===type):r.type===type));
 if(status&&(mode==='matches'||recipientMode))rows=rows.filter(r=>recipientMode?r.assignments.some(a=>a.status===status):r.status===status);
 if(mode==='matches'&&tier)rows=rows.filter(r=>tier==='wider_age'?r.friendship_age_gap_exception:tier==='second_intro'?witnesses(r).length>0:tier==='location_override'?(r.location_preference_exception_user_ids||[]).length>0:tier==='weak_first_introduction'?weak(r):r.quality_tier===tier);
 if(q)rows=rows.filter(r=>JSON.stringify([r,...(mode==='matches'?[people[r.a],people[r.b]]:recipientMode?[people[r.user_id],...r.assignments.map(a=>people[a.other])]:[people[r.user_id]])]).toLowerCase().includes(q));
 const pages=Math.max(1,Math.ceil(rows.length/20));page=Math.min(page,pages-1);$('#list').replaceChildren(...rows.slice(page*20,page*20+20).map(mode==='matches'?match:recipientMode?recipient:mode==='unintroduced'?unintroduced:unmatched));
 $('#count').textContent=rows.length+' '+(mode==='matches'?'proposals':mode==='unintroduced'?'people without an introduction':recipientMode?'recipients':'unmatched selections');$('#page').textContent=(page+1)+' / '+pages;$('#prev').disabled=page===0;$('#next').disabled=page===pages-1;
}
$('#subtitle').textContent='Snapshot: '+D.snapshot_at+' · '+D.plan.summary.pairs+' pairs · '+D.plan.summary.people+' members';const C=D.coverage;
if(isCover){
 $('#coverage').textContent=C.eligible+' eligible active members. '+C.qualifying_pool+' have at least one eligible counterpart; '+C.covered_qualifying_pool+' of them have a draft proposal. '+C.structurally_isolated+' have no eligible counterpart under the remaining hard rules. '+C.proposed_people+' members have at least one proposal without a current review hold; '+C.held_only_people+' have only held proposals. Coverage counts include held proposals and do not mean the draft is ready for release.';
 $('#exceptions').textContent=C.weak_first_introduction_pairs+' weak-fit pairs; '+C.wider_age_pairs+' wider friendship-age pairs; '+C.location_override_pairs+' pairs override the saved local-only preference of '+C.location_override_people+' distinct members. '+(D.policy.ignore_location?'Location was excluded from eligibility and fit scoring by owner instruction; saved member preferences remain visible and unchanged. ':'')+'Fit uses favorite-book affinity, age compatibility, and available shared-activity evidence. Extra introductions and weak-fit exceptions must serve a final sole recipient. Reciprocal romance ages and genders, selected connection types, account holds, blocks, and prior-pair exclusions remain in force.';
 $('#method-note').textContent='Coverage is proved for every person with an eligible edge in the full candidate graph; structurally isolated members cannot be paired under those rules. Pruning retains every such person. Maximum-cardinality matching is solved on the retained graph, followed by fit selection and balanced attachments. This does not establish globally optimal fit, globally minimal helper load, or minimum pair count on the unpruned graph.';
}else{
 $('#coverage').textContent=C.eligible+' eligible members; '+C.people+' have a proposal, including '+C.proposed_people+' with at least one proposal without a current review hold. '+C.held_only_people+' have only held proposals; '+C.unintroduced.length+' have no proposal. '+C.wider_age_pairs+' friendship pairs use the approved wider age range. '+C.second_intro_slots+' extra introductions within a selected type each support a sole-match recipient. '+C.reading_rescue_pairs+' pairs use the declared first-introduction reading exception. Broader reading cutoffs: '+Object.entries(D.policy.candidate_thresholds||{}).map(([k,v])=>k+' '+Math.round(v*100)+'/100').join(', ')+', with higher cutoffs for distance. Local friendship can qualify through two shared activities at '+Math.round((D.policy.local_activity_friendship_threshold||0)*100)+'/100. Cutoffs are policy choices, not calibrated probabilities. First-introduction reading exceptions require at least 0.30 book fit and score, plus a shared favorite book/author or at least 0.45 shelf fit with a shared catalog genre. They must serve an originally unmatched member as their sole introduction. Lower-scoring proposals are labeled. Both people must still have selected the connection type and satisfy all member preferences.';
 $('#method-note').textContent='The solver and any later coverage repairs are recorded below. A feasible draft does not establish a global optimum unless the corresponding stage is proved optimal.';
}
$('#helper-summary').textContent='Maximum introductions for one person: '+C.maximum_total+'. '+C.heavy_helper_count+' helpers receive more than 3. '+C.extra_total_introductions+' introductions are additional to a person’s first; '+C.second_intro_slots+' are additional within a selected type. Recipient counts by total introductions: '+Object.entries(C.total_degree_histogram).map(([degree,count])=>degree+' → '+count).join(', ')+'. Repeated pairs within this draft: '+C.repeated_pair_count+'. Historical pair exclusions are checked by the audit. Use “All recipient assignments” to inspect every assignment.';
if(D.helper_load_verification?.certified_minimum_maximum_load){const V=D.helper_load_verification;$('#method-note').textContent+=' A separate independent check certifies this batch’s minimum possible maximum load as '+V.certified_minimum_maximum_load+': '+V.mandatory_recipients+' romance-only members have only '+V.possible_counterparts+' mutually eligible counterparts across the full cohort. This draft attains that bound; the number of helpers at that load and total fit are not certified optimal.';}
$('#stats').textContent=Object.entries(D.plan.summary.by_type).map(([k,v])=>k+': '+v).join(' · ');const proof=D.plan.allocation_proof;
$('#method').textContent=JSON.stringify({summary:D.plan.summary,coverage:C.summary,allocation_method:D.plan.allocation_method,allocation_proof:proof?{sparsification:proof.sparsification,allocation:proof.allocation,hard_eligible_count:proof.hard_eligible_user_ids?.length,isolated_active_count:proof.isolated_active_user_ids?.length}:undefined,allocation_repair:D.plan.allocation_repair?{...D.plan.allocation_repair,covered_user_ids_before:undefined}:undefined,objective_order:D.objective_order,audit:D.audit,evaluation:D.evaluation,policy:D.policy,plan_sha256:D.plan.plan_sha256},null,2);
['search','mode','type','status','tier'].forEach(id=>$('#'+id).addEventListener(id==='search'?'input':'change',()=>{page=0;render()}));$('#prev').onclick=()=>{page--;render();window.scrollTo(0,0)};$('#next').onclick=()=>{page++;render();window.scrollTo(0,0)};render();
</script></html>'''

def weak_pair(match):
    return match.get('quality_tier')=='weak_first_introduction' or match.get('evidence_route')=='coverage_first_weak_evidence'


def coverage_data(snap,plan):
    edge_cover=plan.get('allocation_method')=='edge_cover'
    counts=collections.Counter(u for m in plan['matches'] for u in (m['a'],m['b']))
    slots=collections.defaultdict(list);witnesses=collections.defaultdict(list)
    per_person=collections.defaultdict(list);total_witnesses=collections.defaultdict(list)
    for m in plan['matches']:
        for u in (m['a'],m['b']):
            slots[(u,m['type'])].append(m);per_person[u].append(m)
    def credit_rows(u,rows):
        return sorted((m for m in rows if counts[m['b'] if m['a']==u else m['a']]==1),key=lambda m:(m['status']!='proposed',-m['score'],m['id']))
    for (u,kind),rows in sorted(slots.items()):
        if len(rows)<2:continue
        candidates=credit_rows(u,rows)
        assert len(candidates)>=len(rows)-1,'Extra introduction lacks a sole-recipient witness'
        for m in candidates[:len(rows)-1]:
            witnesses[m['id']].append({'helper':u,'recipient':m['b'] if m['a']==u else m['a'],'type':kind,
                                       'helper_type_total':len(rows),'helper_total':counts[u]})
    if edge_cover:
        for u,rows in sorted(per_person.items()):
            if len(rows)<2:continue
            candidates=credit_rows(u,rows)
            assert len(candidates)>=len(rows)-1,'Extra total introduction lacks a sole-recipient witness'
            for m in candidates[:len(rows)-1]:
                total_witnesses[m['id']].append({'helper':u,'recipient':m['b'] if m['a']==u else m['a'],
                                               'type':m['type'],'helper_total':counts[u]})
    proposed={u for m in plan['matches'] if m['status']=='proposed' for u in (m['a'],m['b'])}
    eligible={p['user_id'] for p in snap['profiles'] if p['user_id'] not in plan['excluded']}
    proof=plan.get('allocation_proof',{})
    qualifying=set(proof.get('hard_eligible_user_ids',[])) if edge_cover else set(counts)
    isolated=set(proof.get('isolated_active_user_ids',[])) if edge_cover else set()
    unintroduced=[]
    for uid in sorted(eligible-set(counts)):
        rows=[r for r in plan['unmatched'] if r['user_id']==uid]
        if edge_cover:
            reason=('No eligible counterpart remains under selected connection types, reciprocal romance preferences, written requirements, account holds, blocks, identity rules, and prior-pair exclusions.'
                    if uid in isolated else 'Coverage discrepancy: this eligible member is absent from the draft and must be checked before release.')
        else:
            reason=('Qualifying partners exist, but their available introduction slots are allocated elsewhere.' if any(r['candidate_count'] for r in rows)
                    else 'Mutually eligible partners exist, but none passed the declared reading/activity evidence rules.' if any(r['structural_candidate_count'] for r in rows)
                    else 'No mutually eligible partner within selected types, preferences, prior-pair exclusions, and the allowed friendship age ranges.')
        unintroduced.append({'user_id':uid,'reason':reason,'selections':rows})
    assignments={};recipient_by_type={};recipients=[]
    for uid,rows in sorted(per_person.items()):
        assignments[uid]=[{'pair_id':m['id'],'type':m['type'],'other':m['b'] if m['a']==uid else m['a'],
                           'status':m['status'],'score':m['score'],'weak_first_introduction':weak_pair(m),
                           'location_override':bool(m.get('location_preference_exception_user_ids')),
                           'saved_location_preference_overridden':uid in m.get('location_preference_exception_user_ids',[]),
                           'wider_age':bool(m.get('friendship_age_gap_exception'))}
                          for m in sorted(rows,key=lambda m:(m['type'],m['id']))]
        recipient_by_type[uid]=dict(sorted(collections.Counter(m['type'] for m in rows).items()))
        recipients.append({'user_id':uid,'introduction_count':len(rows),'by_type':recipient_by_type[uid],
                           'assignments':assignments[uid],'held_only':uid not in proposed})
    recipients.sort(key=lambda r:(-r['introduction_count'],r['user_id']))
    location_people={u for m in plan['matches'] for u in m.get('location_preference_exception_user_ids',[])}
    pairs=[tuple(sorted((m['a'],m['b']))) for m in plan['matches']]
    coverage={'eligible':len(eligible),'people':len(counts),'proposed_people':len(proposed),'held_only_people':len(set(counts)-proposed),
              'qualifying_pool':len(qualifying),'covered_qualifying_pool':len(qualifying&set(counts)),
              'structurally_isolated':len(isolated),'fully_covered_qualifying_pool':edge_cover and qualifying==set(counts),
              'qualifying_coverage_gap':len(qualifying-set(counts)),
              'wider_age_pairs':sum(m.get('friendship_age_gap_exception',False) for m in plan['matches']),
              'reading_rescue_pairs':sum(bool(m.get('first_introduction_rescue')) and not weak_pair(m) for m in plan['matches']),
              'weak_first_introduction_pairs':sum(weak_pair(m) for m in plan['matches']),
              'location_override_pairs':sum(bool(m.get('location_preference_exception_user_ids')) for m in plan['matches']),
              'location_override_people':len(location_people),
              'member_requested_pairs':sum(bool(m.get('owner_requested_pair')) for m in plan['matches']),
              'contact_hold_pairs':sum(bool(m.get('contact_review_user_ids')) for m in plan['matches']),
              'contact_hold_people':len({u for m in plan['matches'] for u in m.get('contact_review_user_ids',[])}),
              'maximum_total':max(counts.values(),default=0),'maximum_per_type':max((len(rows) for rows in slots.values()),default=0),
              'total_degree_histogram':dict(sorted(collections.Counter(counts.values()).items())),
              'heavy_helper_count':sum(n>3 for n in counts.values()),'extra_total_introductions':sum(n-1 for n in counts.values()),
              'second_intro_slots':sum(len(v) for v in witnesses.values()),
              'second_intro_witnesses':dict(witnesses),'extra_intro_witnesses':dict(total_witnesses),
              'repeated_pair_count':len(pairs)-len(set(pairs)),
              'introductions':dict(counts),'assignments':assignments,'recipient_by_type':recipient_by_type,
              'recipients':recipients,'heavy_helpers':[r for r in recipients if r['introduction_count']>3],'unintroduced':unintroduced}
    large_fields=('introductions','unintroduced','second_intro_witnesses','extra_intro_witnesses','assignments',
                  'recipient_by_type','recipients','heavy_helpers')
    coverage['summary']={k:v for k,v in coverage.items() if k not in large_fields}
    coverage['summary']['no_introduction_reasons']=dict(collections.Counter(r['reason'] for r in unintroduced))
    return coverage


def finite_json(value):
    """An unknown distance may be infinite in source data; JSON.parse needs null."""
    if isinstance(value,float) and not math.isfinite(value):return None
    if isinstance(value,dict):return {k:finite_json(v) for k,v in value.items()}
    if isinstance(value,(list,tuple)):return [finite_json(v) for v in value]
    return value


def main(directory):
    directory=Path(directory);snap=json.loads((directory/'snapshot.json').read_text());plan=json.loads((directory/'plan.json').read_text())
    policy=json.loads((directory/'policy.json').read_text());audit=json.loads((directory/'plan-audit.json').read_text())
    fields=('name','age','city','region','country','intents','location_preference','age_min','age_max','favorites','romance_ideal_match','friendship_interests','business_about','business_skills','business_seeking')
    people={p['user_id']:{k:p.get(k) for k in fields} for p in snap['profiles']}
    coverage=coverage_data(snap,plan)
    write(directory/'coverage.json',coverage)
    if plan.get('allocation_method')=='edge_cover':
        objective_order=['Maximum unique coverage of people with an eligible counterpart',
                         'Maximum-cardinality matching on the retained graph','Fit among maximum-cardinality matchings',
                         'Minimum maximum helper load for the fixed matching','Attachment fit, then load balancing for the fixed matching']
    else:
        objective_order=(['Members with any proposal','Members with an unflagged proposal'] if policy.get('prioritize_any_introduction')
                         else ['Members with an unflagged proposal','Members with any proposal'])+['Unique prior-round missed-romance members','Introduction count','Fit']
    helper_verification_path=directory/'optimizer/final-burden-certificate-verification.json'
    helper_verification=json.loads(helper_verification_path.read_text()) if helper_verification_path.exists() else None
    if helper_verification and not(helper_verification.get('passed') and helper_verification.get('plan_sha256',helper_verification.get('final_plan_sha256'))==plan['plan_sha256']):
        raise ValueError('Helper-load verification does not match the current plan')
    payload={'snapshot_at':snap['snapshot_at'],'people':people,'plan':plan,'audit':audit,'coverage':coverage,
             'helper_load_verification':helper_verification,
             'objective_order':objective_order,
             'evaluation':json.loads((directory/'evaluation.json').read_text()) if (directory/'evaluation.json').exists() else {},
             'boundary_review':json.loads((directory/'boundary-review.json').read_text()) if (directory/'boundary-review.json').exists() else {},
             'policy':{k:v for k,v in policy.items() if k not in ('historical_pairs','historical_romance_user_ids','excluded_user_ids','held_user_ids','manual_pair_decisions','warm_start_pairs')}}
    safe=json.dumps(finite_json(payload),ensure_ascii=False,allow_nan=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    (directory/'review.html').write_text(PAGE.replace('__DATA__',safe))
    write(directory/'unmatched.json',plan['unmatched'])
    print(json.dumps({'review_page':str(directory/'review.html'),'pairs':len(plan['matches'])}))

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('run_dir');main(ap.parse_args().run_dir)
