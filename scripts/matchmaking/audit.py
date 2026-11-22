"""Independent whole-plan invariant checks; does not call the matcher's eligibility function."""
import argparse,collections,hashlib,itertools,json,math
from pathlib import Path
import numpy as np
from prepare import digest,write,key,collect

KINDS=('romance','friends','business_partners')

def independent_requested_pairs(people,policy):
    """Validate narrow private requests without importing matcher request handling."""
    rows=policy.get('requested_pairs',[])
    result={'pairs':{},'reserved':{},'contact_hold_ids':set(),'errors':[]}
    if not isinstance(rows,list):
        result['errors'].append(('requested_pair_policy_shape',None));return result
    seen=set()
    for number,row in enumerate(rows):
        label='requested_pair_'+str(number)
        if not isinstance(row,dict):
            result['errors'].append(('requested_pair_policy_shape',label));continue
        ids=[row.get('a'),row.get('b')];kind=row.get('type')
        valid=(all(isinstance(u,str) and u in people for u in ids) and ids[0]!=ids[1]
               and kind in KINDS and isinstance(row.get('reason'),str) and bool(row['reason'].strip()))
        if not valid:
            result['errors'].append(('requested_pair_policy_shape',label));continue
        profile_ok=row.get('profile_sha256')=={u:digest(people[u]) for u in ids}
        if not profile_ok:result['errors'].append(('requested_pair_profile_evidence_current',label))
        hold_ids=row.get('contact_hold_user_ids')
        expected=sorted(u for u in ids if not people[u]['has_contact'])
        contact_ok=isinstance(hold_ids,list) and hold_ids==expected
        if not contact_ok:result['errors'].append(('requested_contact_hold_exactly_missing_contact',label))
        disjoint=not(set(ids)&seen)
        if not disjoint:result['errors'].append(('requested_pair_endpoints_disjoint',label))
        seen.update(ids)
        release_ok=not expected or policy.get('release_authorized',False) is False
        if not release_ok:result['errors'].append(('requested_contact_hold_is_private_only',label))
        if not(profile_ok and contact_ok and disjoint and release_ok):continue
        pair_key=(kind,*sorted(ids))
        result['pairs'][pair_key]=row
        for u,other in ((ids[0],ids[1]),(ids[1],ids[0])):result['reserved'][u]=(other,kind)
        result['contact_hold_ids'].update(expected)
    return result

def independent_identities(snapshot,policy):
    """Rebuild candidate exclusions without trusting the plan's identity decisions."""
    excluded=set(policy.get('excluded_user_ids',{}))|set(policy.get('held_user_ids',{}))
    excluded|={r['user_id'] for r in snapshot.get('review_accounts',[])}
    excluded|={r['reported_id'] for r in snapshot.get('pending_reports',[])}
    held={(p.get('instagram_handle') or '').strip().casefold() for p in snapshot['profiles']
          if p['user_id'] in policy.get('held_user_ids',{})}-{''}
    contact_holds=independent_requested_pairs({p['user_id']:p for p in snapshot['profiles']},policy)['contact_hold_ids']
    for p in snapshot['profiles']:
        handle=(p.get('instagram_handle') or '').strip().casefold()
        if handle in held or not p['is_active'] or p['age']<18 or (not p['has_contact'] and p['user_id'] not in contact_holds) or not p.get('favorites'):
            excluded.add(p['user_id'])
        if p['user_id'] in policy.get('email_only_user_ids',[]) and not(p.get('share_email_with_matches') and p.get('has_signup_email')):
            excluded.add(p['user_id'])
    groups=collections.defaultdict(list);decisions={}
    for p in snapshot['profiles']:
        handle=(p.get('instagram_handle') or '').strip().casefold()
        if handle and p['user_id'] not in excluded:groups[handle].append(p)
    for group in groups.values():
        retained=max(group,key=lambda p:(p.get('created_at',''),sum(bool(p.get(k)) for k in
                     ('romance_ideal_match','friendship_interests','business_about')),p['user_id']))
        for p in group:
            if p['user_id']!=retained['user_id']:
                excluded.add(p['user_id']);decisions[p['user_id']]=retained['user_id']
    return excluded,decisions

def independent_hard_eligible(a,b,kind,policy,previous,blocks,metros=None,requested=None):
    """No matcher eligibility/scoring calls; used to verify full coverage independently."""
    pair=frozenset((a['user_id'],b['user_id']))
    if len(pair)!=2 or pair in previous or pair in blocks:return False
    if requested is None:
        # Full-graph callers validate once. Direct checks still reserve endpoints
        # when the requested counterpart is not one of these two profiles.
        requested={'reserved':{}}
        for row in policy.get('requested_pairs',[]):
            if isinstance(row,dict) and row.get('type') in KINDS and all(isinstance(row.get(k),str) for k in ('a','b')):
                requested['reserved'][row['a']]=(row['b'],row['type'])
                requested['reserved'][row['b']]=(row['a'],row['type'])
    for p,other in ((a,b),(b,a)):
        reserved=requested['reserved'].get(p['user_id'])
        if reserved is not None and reserved!=(other['user_id'],kind):return False
    if kind not in a['intents'] or kind not in b['intents']:return False
    if not policy.get('ignore_location'):
        if sorted((a['country'],b['country'])) in [sorted(x) for x in policy.get('blocked_country_pairs',[])]:return False
        same_city=a['city_id']==b['city_id']
        same_metro=tuple(sorted((a['city_id'],b['city_id']))) in (metros if metros is not None else
                   {tuple(x) for x in policy.get('verified_metro_city_pairs',[])})
        if not(same_city or same_metro) and any(p['location_preference']=='same_city' for p in (a,b)):return False
    if kind=='romance':
        if a['gender'] not in b['interested_in'] or b['gender'] not in a['interested_in']:return False
        if any(p.get(k) is None for p in (a,b) for k in ('age_min','age_max')):return False
        if not(a['age_min']<=b['age']<=a['age_max'] and b['age_min']<=a['age']<=b['age_max']):return False
    elif kind=='friends' and not policy.get('allow_weak_first_introduction'):
        limit=policy['friendship_age_gap_under_25'] if min(a['age'],b['age'])<25 else policy['friendship_age_gap_other']
        if abs(a['age']-b['age'])>limit:return False
    decision=policy.get('manual_pair_decisions',{}).get(kind+'|'+'|'.join(sorted(pair)))
    return not(decision and decision.get('decision')=='exclude')

def independent_hard_graph(people,active_ids,policy,previous,blocks):
    degrees=collections.Counter();by_type=collections.Counter();signature=hashlib.sha256()
    metros={tuple(x) for x in policy.get('verified_metro_city_pairs',[])}
    requested=independent_requested_pairs(people,policy)
    for kind in KINDS:
        pool=[people[u] for u in sorted(active_ids) if kind in people[u]['intents']]
        for a,b in itertools.combinations(pool,2):
            if independent_hard_eligible(a,b,kind,policy,previous,blocks,metros,requested):
                degrees[a['user_id']]+=1;degrees[b['user_id']]+=1;by_type[kind]+=1
                signature.update(('|'.join((kind,a['user_id'],b['user_id']))+'\n').encode())
    return {'degrees':dict(degrees),'by_type':dict(by_type),'edge_count':sum(by_type.values()),
            'hard_eligible_user_ids':sorted(degrees),'isolated_active_user_ids':sorted(set(active_ids)-set(degrees)),
            'ordered_input_keys_sha256':signature.hexdigest()}

def independent_star_statistics(matches):
    neighbors=collections.defaultdict(set)
    for m in matches:
        neighbors[m['a']].add(m['b']);neighbors[m['b']].add(m['a'])
    degrees=collections.Counter(u for m in matches for u in (m['a'],m['b']))
    unseen=set(neighbors);sizes=[]
    while unseen:
        start=min(unseen);pending=[start];component=set()
        while pending:
            u=pending.pop()
            if u in component:continue
            component.add(u);pending.extend(neighbors[u]-component)
        unseen-=component;sizes.append(len(component))
    return {'covered_user_ids':sorted(degrees),'degrees':dict(degrees),'component_count':len(sizes),
            'component_size_distribution':dict(sorted(collections.Counter(sizes).items())),
            'max_degree':max(degrees.values(),default=0),'single_edge_components':sum(n==2 for n in sizes),
            'multi_edge_stars':sum(n>2 for n in sizes),'leaf_count':sum(d==1 for d in degrees.values()),
            'center_count':sum(d>1 for d in degrees.values()),
            'every_edge_has_sole_endpoint':all(degrees[m['a']]==1 or degrees[m['b']]==1 for m in matches)}

def independent_location_free_components(kind,book,age_gap,policy,activity=None,business=0):
    scale=policy.get('age_gap_scale_years',10)
    if not isinstance(scale,(int,float)) or not math.isfinite(scale) or scale<=0:raise ValueError('age_gap_scale_years must be positive')
    age=1/(1+age_gap/scale)
    if kind=='business_partners':return {'book':.50*book,'complementary_skills':.50*business}
    if kind=='friends' and activity is not None:return {'book':.80*book,'activities':.10*activity,'age':.10*age}
    return {'book':.90*book,'age':.10*age}

def audit(directory,filename='plan.json'):
    directory=Path(directory);plan=json.loads((directory/filename).read_text());snap=json.loads((directory/'snapshot.json').read_text())
    policy=json.loads((directory/'policy.json').read_text());aliases=json.loads((directory/'aliases.json').read_text())
    books=json.loads((directory/'books.json').read_text());model=json.loads((directory/'model.json').read_text())
    people={p['user_id']:p for p in snap['profiles']};catalog={b['work_id'] for b in snap['books']}
    location_free=bool(policy.get('ignore_location'));weak_mode=bool(policy.get('allow_weak_first_introduction'))
    edge_cover=plan.get('allocation_method')=='edge_cover'
    previous={frozenset(p) for p in policy.get('historical_pairs',[])};previous_recs=collections.defaultdict(set)
    for user,ids in policy.get('historical_recommendations_by_user',{}).items():
        previous_recs[user].update(aliases.get(bid,bid) for bid in ids)
    for m in snap['matches']:
        ids=[x['user_id'] for x in m.get('members') or []]
        if len(ids)==2:previous.add(frozenset(ids))
        if m.get('recommended_book_id'):
            for u in ids:previous_recs[u].add(aliases.get(m['recommended_book_id'],m['recommended_book_id']))
    blocks={frozenset([b['blocker_id'],b['blocked_id']]) for b in snap['blocks']}
    review_accounts={r['user_id'] for r in snap['review_accounts']}
    known_excluded=set(policy['excluded_user_ids'])|set(policy['held_user_ids'])|review_accounts
    known_excluded|={r['reported_id'] for r in snap.get('pending_reports',[])}
    read=collections.defaultdict(set)
    for p in people.values():
        for b in p['favorites']+([p['currently_reading']] if p.get('currently_reading') else []):read[p['user_id']].add(aliases.get(b['id'],b['id']))
    for b in snap['library']:read[b['user_id']].add(aliases.get(b['work_id'],b['work_id']))
    errors=[];warnings=[];checks=collections.Counter();seen=set();counts=collections.Counter();totals=collections.Counter();handles=collections.defaultdict(set);wider_age_rows=[]
    def check(ok,label,match_id=None):
        checks[label]+=1
        if not ok:errors.append({'check':label,'match_id':match_id})
    check(digest(snap)==plan['snapshot_sha256'],'snapshot_hash')
    check(digest(policy)==plan['policy_sha256'],'policy_hash')
    requested=independent_requested_pairs(people,policy)
    check(not requested['errors'],'requested_pair_configuration_valid')
    for label,pair_label in requested['errors']:check(False,label,pair_label)
    independent_excluded,independent_decisions=independent_identities(snap,policy)
    check(set(plan['excluded'])==independent_excluded,'input_exclusions_independently_rebuilt')
    reported_decisions={d['suppressed']:d['retained'] for d in plan['identity_decisions']}
    check(reported_decisions==independent_decisions and len(reported_decisions)==len(plan['identity_decisions']),'input_identity_decisions_independently_rebuilt')
    known_excluded|=independent_excluded
    if policy.get('coverage_reference_plan_sha256'):
        reference=json.loads((directory/'coverage-reference-plan.json').read_text())
        check(reference['plan_sha256']==policy['coverage_reference_plan_sha256'],'coverage_reference_plan_hash')
        check(digest({k:v for k,v in reference.items() if k not in ('summary','plan_sha256')})==reference['plan_sha256'],'coverage_reference_content_hash')
        original_covered={u for m in reference['matches'] for u in (m['a'],m['b'])}
        originally_unmatched=set(people)-set(reference['excluded'])-original_covered
        check(set(policy.get('coverage_rescue_user_ids',[]))==originally_unmatched,'reading_rescue_targets_previously_unmatched')
    check(digest(books)==model['books_sha256'],'book_metadata_hash')
    if 'book_metadata_sha256' in plan:check(digest(books)==plan['book_metadata_sha256'],'plan_pins_book_metadata')
    if 'model_manifest_sha256' in plan:check(digest(model)==plan['model_manifest_sha256'],'plan_pins_model_manifest')
    canonical_books,canonical_aliases=collect(snap)
    check(aliases==canonical_aliases,'book_aliases_rebuilt_from_catalog')
    check(all(bid in books and all(books[bid][k]==value for k,value in raw.items()) for bid,raw in canonical_books.items()),'canonical_book_identity_and_frequency')
    rec_catalog=json.loads((Path(__file__).parent/'recommendation_catalog.json').read_text())
    check(digest(rec_catalog)==policy['recommendation_catalog_sha256'],'recommendation_catalog_hash')
    allowed_titles={(key(b['title']),key(b['author'])) for b in rec_catalog['books']}
    check(model['revision']==plan['model_revision'],'model_revision')
    metro_map={};metro_evidence={tuple(x['city_ids']):x for x in policy.get('verified_metro_evidence',[])}
    if policy.get('us_metro_source'):
        source=policy['us_metro_source'];check(hashlib.sha256((directory/'cb_2023_us_cbsa_500k.zip').read_bytes()).hexdigest()==source['sha256'],'metro_boundary_source_hash')
        metro_map=json.loads((directory/'us-metro-cities.json').read_text())['mapped']
    check(hashlib.sha256((directory/'book-vectors.npy').read_bytes()).hexdigest()==plan['book_vectors_sha256'],'vector_hash')
    for name,expected in plan.get('source_hashes',{}).items():
        check(hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest()==expected,'source_file_hash')
    vectors=np.load(directory/'book-vectors.npy',allow_pickle=False);index={b:i for i,b in enumerate(model['ids'])}
    check(np.isfinite(vectors).all(),'finite_vectors')
    check(np.allclose(np.linalg.norm(vectors,axis=1),1.,atol=1e-4),'normalized_vectors')
    def book_similarity(x,y):
        value=round(float(np.clip((np.dot(vectors[index[x]],vectors[index[y]])-.15)/.65,0,1)),6)
        gx,gy=set(books[x]['genres']),set(books[y]['genres'])
        if gx&gy:value=max(value,.5+.1*len(gx&gy)/len(gx|gy))
        if not books[x]['metadata_adequate'] or not books[y]['metadata_adequate']:value=0.
        if key(books[x]['author'])==key(books[y]['author']) and key(books[x]['author']) not in ('','unknown','unknownauthor'):value=max(value,.75)
        return 1. if x==y else value
    core={k:v for k,v in plan.items() if k not in ('summary','plan_sha256')}
    check(digest(core)==plan['plan_sha256'],'plan_content_hash')
    idmap=dict(independent_decisions);idmap.update(policy.get('historical_identity_map',{}))
    def canonical(u):
        seen=set()
        while u in idmap and u not in seen:seen.add(u);u=idmap[u]
        return u
    previous|={frozenset(canonical(u) for u in p) for p in list(previous)}
    blocks|={frozenset(canonical(u) for u in p) for p in list(blocks)}
    had_romance=set(policy.get('historical_romance_user_ids',[]))
    for h in snap['matches']:
        if h['intent']=='romance' and h.get('released_at'):had_romance.update(x['user_id'] for x in h.get('members') or [])
    priority={canonical(u) for u in policy.get('priority_romance_user_ids',[])}-{canonical(u) for u in had_romance}
    for user,ids in list(previous_recs.items()):previous_recs[canonical(user)].update(ids)
    for row in snap['library']:read[canonical(row['user_id'])].add(aliases.get(row['work_id'],row['work_id']))
    for (kind,a_id,b_id),request in requested['pairs'].items():
        check(not({a_id,b_id}&known_excluded) and independent_hard_eligible(people[a_id],people[b_id],kind,policy,previous,blocks,requested=requested),
              'requested_pair_preserves_other_hard_constraints',kind+'|'+a_id+'|'+b_id)
    round_recs=collections.defaultdict(set)
    held_handles={(people[u].get('instagram_handle') or '').strip().casefold() for u in policy['held_user_ids'] if u in people}-{''}
    for pair,decision in policy.get('manual_pair_decisions',{}).items():
        parts=pair.split('|');ids=parts[1:]
        check(len(parts)==3 and parts[0] in KINDS and len(set(ids))==2 and all(u in people for u in ids)
              and decision.get('decision') in ('clear','exclude') and bool(decision.get('rationale'))
              and decision.get('profile_sha256')=={u:digest(people[u]) for u in ids if u in people},
              'all_manual_decision_profile_evidence_current',pair)
    for m in plan['matches']:
        mid=m['id'];a,b=people[m['a']],people[m['b']];pair=frozenset([m['a'],m['b']]);kind=m['type']
        request=requested['pairs'].get((kind,*sorted(pair)))
        expected_contact_review=sorted(u for u in pair if request and not people[u]['has_contact'])
        check(m.get('owner_requested_pair',False) is bool(request),'owner_requested_pair_disclosed',mid)
        check(m.get('contact_review_user_ids',[])==expected_contact_review,'contact_review_users_truthful',mid)
        check(all(u not in requested['reserved'] or requested['reserved'][u]==(other,kind)
                  for u,other in ((m['a'],m['b']),(m['b'],m['a']))),'requested_pair_exclusive_assignment',mid)
        check(len(pair)==2,'two_distinct_members',mid);check(pair not in seen,'one_pair_across_types',mid);seen.add(pair)
        check(pair not in previous,'no_previous_pair',mid);check(pair not in blocks,'no_blocked_pair',mid)
        check(not(pair&known_excluded),'owner_test_report_exclusions',mid)
        check(all(p['is_active'] and (p['has_contact'] or p['user_id'] in expected_contact_review) and p['age']>=18 for p in (a,b)),'active_adult_contactable',mid)
        check(not any((p.get('instagram_handle') or '').strip().casefold() in held_handles for p in (a,b)),'owner_hold_follows_identity',mid)
        check(all(kind in p['intents'] for p in (a,b)),'reciprocal_selected_type',mid)
        check(m['priority_people']==(len(pair&priority) if kind=='romance' else 0),'prior_round_romance_priority',mid)
        check(m.get('priority_user_ids',[])==(sorted(pair&priority) if kind=='romance' else []),'unique_prior_round_romance_priority_members',mid)
        check(location_free or sorted([a['country'],b['country']]) not in [sorted(x) for x in policy['blocked_country_pairs']],'country_pair_policy',mid)
        city_ok=a['city_id']==b['city_id'] or sorted([a['city_id'],b['city_id']]) in policy.get('verified_metro_city_pairs',[])
        check(location_free or city_ok or all(p['location_preference']=='anywhere' for p in (a,b)),'local_preferences_respected',mid)
        expected_location_exceptions=sorted(p['user_id'] for p in (a,b) if location_free and not city_ok and p['location_preference']=='same_city')
        check(m.get('location_preference_exception_user_ids',[])==expected_location_exceptions,'location_preference_exceptions_disclosed',mid)
        evidence=metro_evidence.get(tuple(sorted([a['city_id'],b['city_id']])),{})
        if evidence.get('source_sha256')==policy.get('us_metro_source',{}).get('sha256') and evidence.get('source_sha256'):
            mapped=[metro_map[str(p['city_id'])] for p in (a,b)]
            check(mapped[0]['metro_code']==mapped[1]['metro_code']==evidence['metro_code'],'same_official_us_metro',mid)
            check(all(p['latitude']==g['latitude'] and p['longitude']==g['longitude'] for p,g in zip((a,b),mapped)),'metro_city_coordinates_current',mid)
        if kind=='romance':
            check(a['gender'] in b['interested_in'] and b['gender'] in a['interested_in'],'reciprocal_gender',mid)
            check(all(p.get(k) is not None for p in (a,b) for k in ('age_min','age_max'))
                  and a['age_min']<=b['age']<=a['age_max'] and b['age_min']<=a['age']<=b['age_max'],'reciprocal_age',mid)
        age_exception=False
        if kind=='friends':
            limit=policy['friendship_age_gap_under_25'] if min(a['age'],b['age'])<25 else policy['friendship_age_gap_other']
            check(weak_mode or abs(a['age']-b['age'])<=limit,'friendship_age_policy',mid)
            standard_limit=policy.get('standard_friendship_age_gap_under_25',5 if weak_mode else policy['friendship_age_gap_under_25']) if min(a['age'],b['age'])<25 else policy.get('standard_friendship_age_gap_other',8 if weak_mode else policy['friendship_age_gap_other'])
            age_exception=abs(a['age']-b['age'])>standard_limit
            if age_exception:wider_age_rows.append(m)
        check(m.get('friendship_age_gap_exception',False)==age_exception,'friendship_age_exception_disclosed',mid)
        check(m.get('age_gap_years',abs(a['age']-b['age']))==abs(a['age']-b['age']),'age_gap_disclosed',mid)
        for p in (a,b):
            u=p['user_id'];counts[(u,kind)]+=1;totals[u]+=1
            if p.get('instagram_handle'):handles[p['instagram_handle'].lower()].add(u)
        check(m['score']+1e-6>=m['threshold'],'fit_threshold',mid)
        check(abs(sum(m['score_components'].values())-m['score'])<4e-6,'score_components_sum',mid)
        check(int(round(m['score']*10000))==m['score_integer'],'integer_score_quantization',mid)
        shelves=[sorted({aliases.get(x['id'],x['id']) for x in p['favorites']}) for p in (a,b)]
        author_sets=[{key(x['author']) for x in p['favorites'] if key(x['author']) not in ('','unknown','unknownauthor')} for p in (a,b)]
        similarities=[[book_similarity(x,y) for y in shelves[1]] for x in shelves[0]]
        matrix=np.array(similarities);semantic=(matrix.max(axis=0).mean()+matrix.max(axis=1).mean())/2
        common=set(shelves[0])&set(shelves[1]);author_common=author_sets[0]&author_sets[1]
        exact=min(1,sum(1/math.sqrt(1+math.log1p(books[x]['frequency'])) for x in common))
        author=min(1,len(author_common)/max(1,min(map(len,author_sets))))
        baseline=max(exact,.65*author);expected_fit=baseline if plan['variant']=='baseline' else max(.85*semantic+.10*exact+.05*author,baseline)
        check(abs(expected_fit-m['book_fit'])<5e-6,'independently_recomputed_book_fit',mid)
        check(set(m['book_evidence']['exact_overlap'])==common,'shared_title_claim',mid)
        check(set(m['book_evidence']['author_overlap'])==author_common,'shared_author_claim',mid)
        lat1,lat2=map(math.radians,[a['latitude'],b['latitude']]);lon_delta=math.radians(a['longitude']-b['longitude'])
        distance=6371*math.acos(max(-1,min(1,math.sin(lat1)*math.sin(lat2)+math.cos(lat1)*math.cos(lat2)*math.cos(lon_delta))))
        check(abs(distance-m['distance_km'])<.02,'independently_recomputed_distance',mid)
        surcharge=0 if location_free or weak_mode else (.10 if distance>1000 else .05 if distance>250 else 0)
        expected_threshold=policy['candidate_thresholds'][kind]+surcharge
        # Feature extraction is unit-tested separately; weights are recalculated here.
        from engine import tags,SKILLS
        activities=[tags(p.get('friendship_interests','')) for p in (a,b)]
        shared=activities[0]&activities[1]
        check(set(m['shared_activities'])==shared,'explicit_shared_activity_claim',mid)
        genre_sets=[{g for bid in shelf if books[bid]['metadata_adequate'] for g in books[bid]['genres']} for shelf in shelves]
        shared_genres=genre_sets[0]&genre_sets[1]
        check(set(m.get('shared_genres',shared_genres))==shared_genres,'explicit_shared_genre_claim',mid)
        ab=ba=set();business_strength=0.
        if kind=='business_partners':
            ab=tags(a.get('business_skills',''),SKILLS)&tags(b.get('business_seeking',''),SKILLS)
            ba=tags(b.get('business_skills',''),SKILLS)&tags(a.get('business_seeking',''),SKILLS)
            business_strength=min(1,(len(ab)+len(ba))/4) if ab and ba else 0.
            check(m.get('business_evidence',{})=={'a_offers_b_seeks':sorted(ab),'b_offers_a_seeks':sorted(ba)},'reciprocal_business_evidence_disclosed',mid)
            check(weak_mode or bool(ab and ba),'reciprocal_business_skills',mid)
        standard_threshold=policy.get('standard_candidate_thresholds',policy['candidate_thresholds'])[kind]+surcharge
        check(abs(m.get('standard_threshold',standard_threshold)-standard_threshold)<1e-6,'standard_threshold_disclosed',mid)
        standard=m['score']>=standard_threshold and m['book_fit']>=policy.get('standard_minimum_book_support',.30 if weak_mode else policy['minimum_book_support']) and not age_exception
        reading_qualified=m['book_fit']>=policy['minimum_book_support'] and m['score']>=expected_threshold and ((not weak_mode and not policy.get('coverage_first')) or standard or bool(common or author_common or shared_genres or shared))
        if kind=='business_partners' and not(ab and ba):standard=reading_qualified=False
        activity_qualified=bool((weak_mode or policy.get('allow_local_activity_friendship')) and kind=='friends' and (weak_mode or location_free or (city_ok and distance<=75))
                                and len(shared)>=2 and shared-{'coffee','bookshops','reading together'}
                                and m['score']>=policy.get('local_activity_friendship_threshold',.30))
        if age_exception and not weak_mode:check(m['book_fit']>=policy.get('standard_minimum_book_support',.30) or activity_qualified,'wider_age_requires_supporting_interests',mid)
        targets=sorted(pair&set(policy.get('coverage_rescue_user_ids',[])))
        rule=policy.get('first_introduction_reading_rule');basis=[]
        weak=weak_mode and not(reading_qualified or activity_qualified)
        if weak:basis=['owner_authorized_weak_fit_first_introduction']
        elif not weak_mode and rule and targets and kind in ('romance','friends') and not(reading_qualified or activity_qualified) and expected_fit+1e-6>=rule['minimum_book_fit'] and m['score']>=rule['minimum_score']:
            if common:basis.append('shared_favorite_book')
            if author_common:basis.append('shared_favorite_author')
            if expected_fit+1e-6>=rule['shelf_fit_with_shared_genre'] and shared_genres:basis.append('shelf_fit_and_shared_catalog_genre')
        check(bool(m.get('first_introduction_rescue'))==bool(basis) and m.get('rescue_basis',[])==basis,'reading_rescue_evidence_independently_verified',mid)
        check(m.get('rescue_target_user_ids',[])==(targets if basis and not weak else []),'reading_rescue_targets_disclosed',mid)
        check(reading_qualified or activity_qualified or basis,'minimum_reading_or_local_activity_evidence',mid)
        if weak:expected_threshold=0.
        elif basis:expected_threshold=rule['minimum_score']
        elif not reading_qualified and activity_qualified:expected_threshold=policy['local_activity_friendship_threshold']
        check(abs(expected_threshold-m['threshold'])<1e-6,'distance_adjusted_threshold',mid)
        check(m.get('quality_tier','standard')==('weak_first_introduction' if weak else 'first_introduction_reading' if basis else 'standard' if standard else 'broader_first_introduction'),'quality_tier_truthful',mid)
        check(m['evidence_route']==('coverage_first_weak_evidence' if weak else 'reading_starting_point' if basis else 'reading' if reading_qualified else 'shared_activities' if weak_mode else 'local_shared_activities'),'evidence_route_truthful',mid)
        location=next(v for upper,v in ((25,1.),(50,.95),(150,.85),(250,.70),(1000,.45),(3000,.25),(math.inf,.10)) if distance<=upper)
        if location_free or weak_mode:
            activity_ratio=len(shared)/min(map(len,activities)) if all(activities) else None
            expected_components=independent_location_free_components(kind,expected_fit,abs(a['age']-b['age']),policy,activity_ratio,business_strength)
            check(set(m['score_components'])==set(expected_components) and all(abs(m['score_components'][k]-v)<5e-6 for k,v in expected_components.items()),'location_free_score_components_independently_recomputed',mid)
            weighted=sum(expected_components.values())
        elif kind=='business_partners':
            weighted=.35*expected_fit+.50*business_strength+.15*location
        elif all(activities):
            weighted=.65*expected_fit+.20*len(shared)/min(map(len,activities))+.15*location
        else:weighted=.75*expected_fit+.25*location
        check(abs(weighted-m['score'])<5e-6,'independently_recomputed_weighted_score',mid)
        expected_routes=[u for u in (m['a'],m['b']) if u in policy.get('email_only_user_ids',[])]
        check(expected_routes==m.get('email_only_user_ids',[]),'contact_route_override_preserved',mid)
        check(0<len(m['member_reason'])<=1000,'member_explanation_present',mid)
        decision=m.get('review_decision')
        policy_decision=policy.get('manual_pair_decisions',{}).get(kind+'|'+'|'.join(sorted((m['a'],m['b']))))
        check(decision==policy_decision and not(policy_decision and policy_decision['decision']=='exclude'),'explicit_review_decision_respected',mid)
        from engine import constraint_flags
        expected_flags=[] if policy_decision and policy_decision['decision']=='clear' else constraint_flags(a,b,kind)
        check(m['written_boundary_flags']==expected_flags,'written_requirement_flags_recomputed',mid)
        if decision:
            check(decision.get('decision')=='clear' and decision.get('profile_sha256')=={p['user_id']:digest(p) for p in (a,b)},'review_evidence_current',mid)
        rec=m.get('recommended_book')
        if rec:
            check(rec['title']==books[rec['id']]['title'] and rec['author']==books[rec['id']]['author'],'recommendation_identity_matches_frozen_book',mid)
            check(rec['id'] in policy['recommendation_allowlist'] and (key(rec['title']),key(rec['author'])) in allowed_titles,'recommendation_is_curated_entry_point',mid)
            check(rec['id'] in catalog,'recommendation_in_live_catalog',mid)
            check(rec['id'] not in (read[m['a']]|read[m['b']]|previous_recs[m['a']]|previous_recs[m['b']]),'recommendation_new_to_both',mid)
            forbidden=read[m['a']]|read[m['b']]|previous_recs[m['a']]|previous_recs[m['b']]|round_recs[m['a']]|round_recs[m['b']]
            forbidden_works={books[bid]['metadata'].get('source_work_id') for bid in forbidden if bid in books}-{None,''}
            check(books[rec['id']]['metadata'].get('source_work_id') not in forbidden_works,'recommendation_not_duplicate_source_work',mid)
            protected={(key(b['title']),key(b['author'])) for b in rec_catalog['books'] if b.get('avoid_if_any_read_same_author')}
            read_authors={key(books[bid]['author']) for bid in forbidden if bid in books}-{key('Unknown author'),''}
            check((key(rec['title']),key(rec['author'])) not in protected or key(rec['author']) not in read_authors,'series_entry_not_suggested_to_existing_author_reader',mid)
            check(all(rec['id'] not in round_recs[u] for u in (m['a'],m['b'])),'no_repeat_recommendation_this_round',mid)
            for u in (m['a'],m['b']):round_recs[u].add(rec['id'])
            check(min(rec['a_affinity'],rec['b_affinity'])>=.35,'recommendation_supports_both',mid)
            check(0<len(rec['reason'])<=600,'recommendation_explanation_present',mid)
            check(books[rec['id']]['metadata_adequate'],'recommendation_has_metadata',mid)
            for shelf,field in zip(shelves,('a_affinity','b_affinity')):
                values=[book_similarity(x,rec['id']) for x in shelf]
                affinity=.7*max(values)+.3*sum(values)/len(values)
                check(abs(affinity-rec[field])<5e-6,'independently_recomputed_recommendation_support',mid)
            check(rec['source_url']==books[rec['id']]['metadata']['source_url'],'recommendation_source',mid)
        else:warnings.append({'match_id':mid,'reason':'No supported new book recommendation'})
        if m.get('written_boundary_flags'):warnings.append({'match_id':mid,'reason':'Written preference requires review','count':len(m['written_boundary_flags'])})
        if expected_contact_review:
            warnings.append({'match_id':mid,'reason':'Requested introduction lacks a consented contact route','user_ids':expected_contact_review})
            check(plan.get('release_authorized',False) is False,'contact_review_plan_not_release_authorized',mid)
            check(m['status']=='needs_contact_review' and m['release_authorized'] is False,'requested_contact_hold_status_enforced',mid)
        check(m.get('boundary_review_required',bool(m.get('written_boundary_flags')))==bool(m.get('written_boundary_flags')),'coverage_flag_matches_review_status',mid)
        expected_status='needs_contact_review' if expected_contact_review else 'needs_boundary_review' if m.get('written_boundary_flags') else 'needs_book_review' if not rec else 'proposed'
        check(m['status']==expected_status and not m['release_authorized'],'review_status_and_release_boundary',mid)
    for (kind,a_id,b_id),request in requested['pairs'].items():
        selected=[m for m in plan['matches'] if m['type']==kind and {m['a'],m['b']}=={a_id,b_id}]
        check(len(selected)==1,'requested_pair_included_exactly_once',kind+'|'+a_id+'|'+b_id)
        check(totals[a_id]==totals[b_id]==1,'requested_endpoints_have_no_other_introductions',kind+'|'+a_id+'|'+b_id)
    check(all(c<=policy['max_per_type'] for c in counts.values()),'per_selected_type_capacity')
    check(all(c<=policy['max_total'] for c in totals.values()),'total_cap')
    if policy.get('second_intro_only_for_first_match'):
        credits=collections.Counter((u,m['type']) for m in plan['matches'] for u,other in ((m['a'],m['b']),(m['b'],m['a'])) if totals[other]==1)
        for slot,n in counts.items():
            if n>1:check(credits[slot]>=n-1,'second_introduction_serves_someones_only_match',slot[0]+'|'+slot[1])
    for m in plan['matches']:
        if m.get('first_introduction_rescue'):
            if weak_mode:
                check(totals[m['a']]==1 or totals[m['b']]==1,'weak_introduction_has_a_sole_recipient',m['id'])
            else:check(any(totals[u]==1 for u in m['rescue_target_user_ids']),'reading_rescue_serves_previously_unmatched_persons_only_match',m['id'])
    coverage_validation=None
    check(not weak_mode or edge_cover,'weak_coverage_requires_edge_cover_proof')
    if edge_cover or weak_mode:
        check(weak_mode,'edge_cover_all_hard_eligible_pairs_admitted')
        active_ids=set(people)-independent_excluded
        hard_graph=independent_hard_graph(people,active_ids,policy,previous,blocks)
        expected_covered=set(hard_graph['hard_eligible_user_ids']);isolated=set(hard_graph['isolated_active_user_ids'])
        check(set(totals)==expected_covered,'all_nonisolated_active_members_covered')
        for m in plan['matches']:
            check(totals[m['a']]==1 or totals[m['b']]==1,'every_selected_edge_has_a_sole_recipient',m['id'])
        proof=plan.get('allocation_proof',{})
        check(proof.get('hard_eligible_user_ids')==sorted(expected_covered),'hard_eligible_vertices_independently_rebuilt')
        check(proof.get('isolated_active_user_ids')==sorted(isolated),'isolated_vertices_independently_rebuilt')
        sparse=proof.get('sparsification',{});allocation=proof.get('allocation',{})
        check(sparse.get('input_edges')==hard_graph['edge_count'],'full_hard_graph_edge_count_independently_rebuilt')
        check(sparse.get('input_vertices')==len(expected_covered),'full_hard_graph_vertex_count_independently_rebuilt')
        check(sparse.get('retained_vertices')==len(expected_covered) and sparse.get('lost_nonisolated_vertices')==0
              and sparse.get('coverage_preserved_exactly') is True,'sparse_graph_retains_all_nonisolated_vertices')
        check(sparse.get('ordered_input_keys_sha256')==hard_graph['ordered_input_keys_sha256'],'full_hard_graph_ordered_keys_hash_independently_rebuilt')
        retained_count=sparse.get('retained_edges')
        check(isinstance(retained_count,int) and len(plan['matches'])<=retained_count<=hard_graph['edge_count'],'retained_edge_count_bounds')
        candidates_path=directory/(plan['variant']+'-candidates.jsonl')
        check(candidates_path.is_file(),'retained_candidate_artifact_present')
        if candidates_path.is_file():
            retained_vertices=set();retained_keys=set();retained_rows=0;invalid_retained=0
            metros={tuple(x) for x in policy.get('verified_metro_city_pairs',[])}
            selected_by_key={(m['type'],*sorted((m['a'],m['b']))):m for m in plan['matches']}
            selected_keys_found=set()
            with candidates_path.open() as candidate_file:
                for line in candidate_file:
                    e=json.loads(line);retained_rows+=1;edge_key=(e['type'],*sorted((e['a'],e['b'])))
                    retained_keys.add(edge_key);retained_vertices.update((e['a'],e['b']))
                    if e['a'] not in active_ids or e['b'] not in active_ids or not independent_hard_eligible(people[e['a']],people[e['b']],e['type'],policy,previous,blocks,metros,requested):invalid_retained+=1
                    if edge_key in selected_by_key:
                        selected_keys_found.add(edge_key)
                        check(all(selected_by_key[edge_key].get(k)==v for k,v in e.items()),'selected_edge_matches_retained_candidate',selected_by_key[edge_key]['id'])
            check(retained_rows==retained_count and len(retained_keys)==retained_rows,'retained_candidate_count_and_unique_keys')
            check(retained_vertices==expected_covered,'retained_candidate_vertices_independently_rebuilt')
            check(invalid_retained==0,'all_retained_candidates_hard_eligible')
            check(selected_keys_found==set(selected_by_key),'all_selected_edges_from_retained_graph')
        stats=independent_star_statistics(plan['matches'])
        check(allocation.get('passed') is True and allocation.get('failures')==[],'edge_cover_report_claims_success')
        check(allocation.get('people')==len(totals) and allocation.get('pairs')==len(plan['matches']),'edge_cover_reported_counts')
        check(allocation.get('maximum_total')==max(totals.values(),default=0),'edge_cover_maximum_total')
        check(allocation.get('maximum_per_type')==max(counts.values(),default=0),'edge_cover_maximum_per_type')
        histogram={str(k):v for k,v in sorted(collections.Counter(totals.values()).items())}
        check(allocation.get('total_degree_histogram')==histogram,'edge_cover_degree_histogram')
        check(allocation.get('extra_per_type_introductions')==sum(max(0,c-1) for c in counts.values()),'edge_cover_extra_per_type_count')
        heavy=[{'user_id':u,'total':n,'by_type':{kind:counts[(u,kind)] for kind in KINDS if counts[(u,kind)]}}
               for u,n in sorted(totals.items(),key=lambda row:(-row[1],row[0])) if n>3]
        check(allocation.get('heavy_helpers_over_three')==heavy,'edge_cover_heavy_helpers_disclosed')
        check(allocation.get('everyone_in_input_with_at_least_one_edge_is_covered') is True
              and set(totals)==expected_covered,'edge_cover_coverage_claim_true')
        check(allocation.get('every_pair_has_a_sole_recipient') is True and stats['every_edge_has_sole_endpoint'],'edge_cover_sole_recipient_claim_true')
        check(allocation.get('global_minimum_helper_load_proven') is False,'edge_cover_does_not_claim_unproved_global_helper_optimality')
        check(allocation.get('maximum_achievable_people_with_input_edges')==len(expected_covered)
              and allocation.get('unique_coverage_optimal_on_full_input_graph') is True,'edge_cover_coverage_upper_bound_exact')
        matching_pairs=allocation.get('matching_pairs');matching_covered=allocation.get('matching_covered_people')
        check(isinstance(matching_pairs,int) and matching_pairs>=0 and matching_covered==2*matching_pairs
              and matching_covered<=len(expected_covered) and matching_pairs==stats['component_count'],'edge_cover_matching_counts_consistent')
        if isinstance(matching_pairs,int):
            check(allocation.get('minimum_pair_count_on_retained_graph')==len(expected_covered)-matching_pairs==len(plan['matches']),
                  'edge_cover_minimum_pair_formula_consistent')
        check(allocation.get('minimum_pair_count_on_full_input_graph_proven')==(len(plan['matches'])==math.ceil(len(expected_covered)/2)),
              'edge_cover_full_graph_minimum_pair_claim_bounded')
        coverage_validation={'active_people':len(active_ids),'hard_eligible_people':len(expected_covered),
                             'isolated_active_user_ids':sorted(isolated),'covered_people':len(totals),
                             'full_hard_edge_count':hard_graph['edge_count'],'full_hard_edge_count_by_type':hard_graph['by_type'],
                             'selected_star_statistics':{k:v for k,v in stats.items() if k not in ('degrees','covered_user_ids')},
                             'note':'Eligibility, all-vertex coverage, and final sole-recipient structure are independently recomputed. Matching weight optimality is not certified by this audit.'}
    check(plan['summary']['pairs']==len(plan['matches']) and plan['summary']['people']==len(totals),'reported_pair_and_person_counts')
    check(plan['summary']['by_type']==dict(collections.Counter(m['type'] for m in plan['matches'])),'reported_type_counts')
    check(plan['summary']['statuses']==dict(collections.Counter(m['status'] for m in plan['matches'])),'reported_review_counts')
    repair=plan.get('allocation_repair')
    if repair:
        coverage_counts={'members_with_any_proposal':len(totals),
                         'members_with_unflagged_proposal':len({u for m in plan['matches'] if not m['boundary_review_required'] for u in (m['a'],m['b'])})}
        expected_metrics={**coverage_counts,'previously_without_romance':len({u for m in plan['matches'] for u in m['priority_user_ids']}),
                          'introductions':len(plan['matches']),'fit_score':sum(m['score_integer'] for m in plan['matches'])}
        check(repair['after']==[expected_metrics[k] for k in repair['objective_order']],'coverage_repair_final_metrics',None)
        check(set(repair['covered_user_ids_before'])<=set(totals),'coverage_repair_preserves_existing_recipients')
        check(repair['before']==[s['objective'] for s in plan['summary']['solver_stages']],'coverage_repair_start_matches_solver_result')
        check(repair['after']>=repair['before'],'coverage_repair_improves_lexicographic_objective')
        if policy.get('prioritize_any_introduction'):
            check(repair['after'][0]<=plan['summary']['solver_stages'][0]['best_bound'],'final_coverage_within_solver_upper_bound')
    for m in wider_age_rows:check(totals[m['a']]==1 or totals[m['b']]==1,'wider_age_helps_someones_only_introduction',m['id'])
    check(all(len(users)==1 for users in handles.values()),'one_account_per_contact_handle')
    expected={(u,k) for u,p in people.items() for k in p['intents']};assigned=set(counts);unmatched={(r['user_id'],r['type']) for r in plan['unmatched']}
    check(not(assigned&unmatched) and assigned|unmatched==expected,'every_member_type_accounted_for')
    check(len(unmatched)==len(plan['unmatched']),'no_duplicate_unmatched_rows')
    result={'automated_checks_passed':not errors,'checks':dict(checks),'errors':errors,'review_items':warnings,
            'proposed_pairs':len(plan['matches']),'plan_sha256':plan['plan_sha256'],
            'release_authorized':False,'note':'Automated correctness checks do not certify personal chemistry or resolve unknown written requirements.'}
    if coverage_validation is not None:result['coverage_validation']=coverage_validation
    target=directory/(Path(filename).stem+'-audit.json');write(target,result)
    print(json.dumps({'automated_checks_passed':not errors,'checks':sum(checks.values()),'errors':errors,'review_items':len(warnings)}))
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('run_dir');parser.add_argument('--plan',default='plan.json');args=parser.parse_args()
    result=audit(args.run_dir,args.plan)
    if result['errors']:raise SystemExit(1)
