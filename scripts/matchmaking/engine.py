"""Deterministic offline introduction planning. No database writes or LLM judgments."""
from __future__ import annotations
import argparse, collections, hashlib, itertools, json, math, re, time, uuid
from pathlib import Path
import numpy as np
from ortools.sat.python import cp_model
from prepare import key, digest, write

KINDS=('romance','friends','business_partners')
ACTIVITIES={
 'coffee':r'\bcaf[eé]s?\b|\bcoffee\b', 'bookshops':r'book\s*shop|bookstore|book shopping|bookshopping',
 'walks':r'\bwalk|\bstroll|\bpark', 'hiking':r'\bhik|\btrek', 'museums and galleries':r'museum|galler',
 'reading together':r'buddy.read|read(?:ing)? together|silent reading|quiet reading|cozy reading|cozy read|cosy read',
 'music':r'\bmusic|concert|live band', 'games':r'board game|\bgaming\b|video game|\bgames\b',
 'films':r'\bfilm|\bmovie|cinema', 'cooking':r'\bcook|\bbak(?:e|ing)',
 'writing':r'\bwrit|poetry', 'art':r'\bpaint|\bdraw|\bart\b', 'exercise':r'\bgym\b|\brunning\b|\byoga\b|\bcycling\b',
}
SKILLS={
 'software':r'programming|software|coding|developer|web development|\btech\b',
 'design':r'\bdesign|illustrat|graphic|branding', 'marketing':r'marketing|social media|advertis|promotion',
 'writing':r'\bwrit|copywrit|editing|editor|publishing', 'events':r'event|book club|bookclub|organis|organiz',
 'finance':r'finance|accounting|bookkeeping|investment', 'sales':r'\bsales\b|business development',
 'operations':r'operations|project management|logistics', 'law':r'\blaw\b|\blegal\b',
 'teaching':r'teach|tutor|education|training', 'research':r'\bresearch|data analysis|analytics',
}
# These are audit flags, not inferred attributes and not automatic rejection.
BOUNDARY=re.compile(r'\b(must|deal.?breaker|only|smok\w*|non.?smok\w*|sober|alcohol|god.fearing|faith|christian|muslim|hindu|jewish|buddhist|catholic|orthodox|atheist|agnostic|religio\w*|child.?free|children|kids|family|monogam\w*|polyamor\w*|serious relationship|casual relationship|long.term|marriage|married|single|vegan|vegetarian|plant.based|conservative|liberal|politic\w*|left.leaning|right.leaning|physically fit|fitness|long.distance|moving to|relocat\w*|speak\w*|not interested|do not want|don.t want)\b',re.I)
BOUNDARY_EXTRA=re.compile(r'\b(?:jesus|god|lds|mormon|leftist|progressive|feminist|trump|pro.choice|pro.life|vap\w*|cishet|non.?negotiabl\w*|tall\w*|shorter|height|has to|have to be|needs to|or bust)\b|[3-7]\s*[\x27’′]\s*\d',re.I)
FRIEND_BOUNDARY=re.compile(r'\b(?:dni|no.?go|must love|deal.?breaker|non.?negotiabl\w*|only (?:female|women|girls|male|men))\b',re.I)
FRIEND_FEMALE_PREFERENCE=re.compile(r'\b(?:for girls|sister.friend|primarily female)\b',re.I)

def tags(text, patterns=ACTIVITIES):
    text=text or ''; result=set()
    for label,pattern in patterns.items():
        for match in re.finditer(pattern,text,re.I):
            before=re.split(r'[.;!\n]',text[max(0,match.start()-65):match.start()])[-1]
            before=re.sub(r'\bnot only\b','',before,flags=re.I)
            if re.search(r"\b(?:not|no|don.t|do not|dislike|hate|without|avoid|can.t|cannot)\b(?:\W+\w+){0,4}\W*$",before,re.I):continue
            result.add(label);break
    return result

def km(a,b):
    if any(p.get(k) is None for p in (a,b) for k in ('latitude','longitude')): return math.inf
    lat1,lat2=math.radians(a['latitude']),math.radians(b['latitude'])
    delta=math.radians(b['longitude']-a['longitude'])
    h=math.sin((lat2-lat1)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(delta/2)**2
    return 12742*math.asin(min(1,math.sqrt(max(0,h))))

def pair_key(a,b): return '|'.join(sorted((a,b)))

def radius_rejection(a,b):
    """Explicit member radii always apply, including coverage/location overrides."""
    limits=[p.get('match_radius_miles') for p in (a,b) if p['location_preference']=='radius']
    if not limits:return None
    if any(type(n) is not int or not 1<=n<=300 for n in limits):return 'invalid_distance_radius'
    limits=[n for n in limits if n<300] # 300+ is the slider's no-cap endpoint.
    if not limits:return None
    for p in (a,b):
        for key,bound in (('latitude',90),('longitude',180)):
            value=p.get(key)
            if not isinstance(value,(int,float)) or not math.isfinite(value) or abs(value)>bound:return 'unknown_distance'
    if km(a,b)/1.609344>min(limits):return 'distance_radius_preference'
    return None

def validate_requested_pairs(people,policy):
    """An owner request applies only to two exact, current profiles in a draft."""
    requested={};reserved=set()
    for row in policy.get('requested_pairs',[]):
        a,b,kind=row.get('a'),row.get('b'),row.get('type')
        if not isinstance(a,str) or not isinstance(b,str) or a==b or kind not in KINDS:
            raise ValueError('Invalid owner-requested pair')
        if a not in people or b not in people:raise ValueError('Requested pair profile is missing')
        if {a,b}&reserved:raise ValueError('Requested pair endpoints must be unique across requests')
        if not isinstance(row.get('reason'),str) or not row['reason'].strip():
            raise ValueError('Requested pair needs an explicit owner-request reason')
        if row.get('profile_sha256')!={u:digest(people[u]) for u in (a,b)}:
            raise ValueError('Stale or missing profile evidence for requested pair')
        holds=row.get('contact_hold_user_ids',[])
        if not isinstance(holds,list) or any(not isinstance(u,str) for u in holds) or len(set(holds))!=len(holds) or not set(holds)<={a,b}:
            raise ValueError('Invalid requested-pair contact hold IDs')
        missing={u for u in (a,b) if not people[u].get('has_contact')}
        if holds!=sorted(missing):
            raise ValueError('Requested-pair contact holds must exactly name endpoints without a consented contact route')
        if holds and policy.get('release_authorized'):
            raise ValueError('Requested contact-hold pair is private planning only')
        reserved.update((a,b));requested[kind+'|'+pair_key(a,b)]=row
    return requested

def requested_reservations(policy):
    return {u:row['type']+'|'+pair_key(row['a'],row['b'])
            for row in policy.get('requested_pairs',[]) for u in (row['a'],row['b'])}

def requested_edge_fields(a,b,kind,policy):
    wanted=kind+'|'+pair_key(a,b)
    row=next((r for r in policy.get('requested_pairs',[]) if r['type']+'|'+pair_key(r['a'],r['b'])==wanted),None)
    return {'owner_requested_pair':row is not None,
            'contact_review_user_ids':sorted(row.get('contact_hold_user_ids',[])) if row else []}

def validate_requested_eligibility(people,policy,excluded,previous_pairs,blocked_pairs):
    requested=validate_requested_pairs(people,policy)
    for key,row in requested.items():
        for u in (row['a'],row['b']):
            if u in excluded:raise ValueError('Requested pair contains excluded member: '+excluded[u])
        reason=eligible(people[row['a']],people[row['b']],row['type'],policy,previous_pairs,blocked_pairs)
        decision=policy.get('manual_pair_decisions',{}).get(key)
        if not reason and decision and decision.get('decision')=='exclude':reason='reviewed_written_boundary'
        if reason:raise ValueError('Requested pair is ineligible: '+reason)
    return requested

def validate_requested_edges(edges,policy,stage):
    """Never silently omit an explicit pair or give either member another match."""
    requests={row['type']+'|'+pair_key(row['a'],row['b']):row for row in policy.get('requested_pairs',[])}
    if not requests:return
    reservations=requested_reservations(policy);counts=collections.Counter()
    for edge in edges:
        key=edge['type']+'|'+pair_key(edge['a'],edge['b'])
        if any(u in reservations and reservations[u]!=key for u in (edge['a'],edge['b'])):
            raise ValueError('Requested pair exclusivity violated in '+stage)
        if key in requests:counts[key]+=1
        expected=requested_edge_fields(edge['a'],edge['b'],edge['type'],policy)
        if any(edge.get(k)!=v for k,v in expected.items()):
            raise ValueError('Requested pair/contact disclosure mismatch in '+stage)
    if any(counts[key]!=1 for key in requests):
        raise ValueError('Requested pair missing or duplicated in '+stage)

def history_data(snapshot):
    pairs=set(); romance=set(); recommendations=collections.defaultdict(set)
    for m in snapshot['matches']:
        members=m.get('members') or []; ids=sorted(x['user_id'] for x in members)
        if len(ids)==2: pairs.add(pair_key(*ids))
        if m.get('released_at'):
            if m['intent']=='romance': romance.update(ids)
            if m.get('recommended_book_id'):
                for u in ids: recommendations[u].add(m['recommended_book_id'])
    return pairs,romance,recommendations

def exclusions(snapshot,policy):
    requested=validate_requested_pairs({p['user_id']:p for p in snapshot['profiles']},policy)
    contact_holds={u for row in requested.values() for u in row.get('contact_hold_user_ids',[])}
    excluded={**policy.get('excluded_user_ids',{}),**policy.get('held_user_ids',{})}
    held_handles={(p.get('instagram_handle') or '').strip().casefold() for p in snapshot['profiles']
                  if p['user_id'] in policy.get('held_user_ids',{})}-{''}
    for row in snapshot.get('review_accounts',[]): excluded[row['user_id']]='Isolated review/test account'
    for row in snapshot.get('pending_reports',[]): excluded[row['reported_id']]='Pending member report requires owner review'
    for p in snapshot['profiles']:
        if (p.get('instagram_handle') or '').strip().casefold() in held_handles: excluded[p['user_id']]='Explicit owner hold applies to this contact identity'
        elif not p['is_active']: excluded[p['user_id']]='Paused profile'
        elif p['age']<18: excluded[p['user_id']]='Under 18'
        elif not p['has_contact'] and p['user_id'] not in contact_holds: excluded[p['user_id']]='No consented contact route'
        elif not p.get('favorites'): excluded[p['user_id']]='No favorite books'
        if p['user_id'] in policy.get('email_only_user_ids',[]) and not(p.get('share_email_with_matches') and p.get('has_signup_email')):
            excluded[p['user_id']]='Owner-specified email contact route is unavailable'
    groups=collections.defaultdict(list); decisions=[]
    for p in snapshot['profiles']:
        handle=(p.get('instagram_handle') or '').strip().casefold()
        if handle and p['user_id'] not in excluded: groups[handle].append(p)
    for members in groups.values():
        if len(members)<2: continue
        chosen=max(members,key=lambda p:(p.get('created_at',''),sum(bool(p.get(k)) for k in ('romance_ideal_match','friendship_interests','business_about')),p['user_id']))
        for p in members:
            if p is chosen: continue
            excluded[p['user_id']]='Duplicate contact handle; newer active account retained'
            decisions.append({'suppressed':p['user_id'],'retained':chosen['user_id'],'basis':'Identical supplied Instagram handle; previous owner policy prefers newest active account.'})
    return excluded,decisions

def eligible(a,b,kind,policy,previous_pairs,blocked_pairs):
    """Return a stable reason code, or None. Do not infer preferences from books."""
    if a['user_id']==b['user_id']: return 'self'
    reservations=policy.get('_requested_reservations')
    if reservations is None:reservations=requested_reservations(policy)
    if a['user_id'] in reservations or b['user_id'] in reservations:
        requested_key=kind+'|'+pair_key(a['user_id'],b['user_id'])
        if any(u in reservations and reservations[u]!=requested_key for u in (a['user_id'],b['user_id'])):
            return 'exclusive_owner_requested_pair'
    if pair_key(a['user_id'],b['user_id']) in blocked_pairs: return 'blocked'
    if pair_key(a['user_id'],b['user_id']) in previous_pairs: return 'previous_introduction'
    if kind not in a['intents'] or kind not in b['intents']: return 'type_not_selected_by_both'
    radius_reason=radius_rejection(a,b)
    if radius_reason:return radius_reason
    country_pair=tuple(sorted((a['country'],b['country'])))
    country_pairs=policy.get('_country_pairs')
    if not policy.get('ignore_location') and country_pair in (country_pairs if country_pairs is not None else {tuple(sorted(x)) for x in policy.get('blocked_country_pairs',[])}):return 'owner_country_pair_restriction'
    cities=sorted((a['city_id'],b['city_id']))
    metros=policy.get('_metro_pairs')
    same_metro=a['city_id']==b['city_id'] or (tuple(cities) in metros if metros is not None else cities in policy.get('verified_metro_city_pairs',[]))
    if not policy.get('ignore_location') and (a['location_preference']=='same_city' or b['location_preference']=='same_city') and not same_metro: return 'city_or_metro_preference'
    if kind=='romance':
        if a['gender'] not in b['interested_in'] or b['gender'] not in a['interested_in']: return 'reciprocal_gender_preference'
        if any(p.get(k) is None for p in (a,b) for k in ('age_min','age_max')): return 'missing_romantic_age_range'
        if not a['age_min']<=b['age']<=a['age_max'] or not b['age_min']<=a['age']<=b['age_max']: return 'reciprocal_age_preference'
    elif kind=='friends':
        limit=policy['friendship_age_gap_under_25'] if min(a['age'],b['age'])<25 else policy['friendship_age_gap_other']
        if abs(a['age']-b['age'])>limit: return 'friendship_age_gap_policy'
    return None

def location_fit(distance):
    if distance<=25: return 1.
    if distance<=50: return .95
    if distance<=150: return .85
    if distance<=250: return .70
    if distance<=1000: return .45
    if distance<=3000: return .25
    return .10

def score_components(kind,book,activity,location,business=None):
    if kind=='business_partners':
        return {'book':.35*book,'complementary_skills':.50*(business or 0),'location':.15*location}
    if activity is None:
        return {'book':.75*book,'location':.25*location}
    return {'book':.65*book,'activities':.20*activity,'location':.15*location}

def threshold_for(kind,distance,policy):
    return policy['candidate_thresholds'][kind]+(0 if policy.get('ignore_location') else .10 if distance>1000 else .05 if distance>250 else 0)

def books_age_components(kind,book,activity,age_gap,policy,business=0):
    age=1/(1+age_gap/policy.get('age_gap_scale_years',10))
    if kind=='business_partners':return {'book':.50*book,'complementary_skills':.50*business}
    if kind=='friends' and activity is not None:return {'book':.80*book,'activities':.10*activity,'age':.10*age}
    return {'book':.90*book,'age':.10*age}

def reading_rescue_basis(kind,fit,score,book,shared_genres,targets,policy):
    rule=policy.get('first_introduction_reading_rule')
    if not rule or not targets or kind not in ('romance','friends'):return []
    if fit<rule['minimum_book_fit'] or score<rule['minimum_score']:return []
    basis=[]
    if book['exact_overlap']:basis.append('shared_favorite_book')
    if book['author_overlap']:basis.append('shared_favorite_author')
    if fit>=rule['shelf_fit_with_shared_genre'] and shared_genres:basis.append('shelf_fit_and_shared_catalog_genre')
    return basis

def constraint_flags(a,b,kind):
    if kind not in ('romance','friends'): return []
    result=[]
    for p,other in ((a,b),(b,a)):
        text=p.get('romance_ideal_match' if kind=='romance' else 'friendship_interests','')
        patterns=(BOUNDARY,BOUNDARY_EXTRA) if kind=='romance' else (FRIEND_BOUNDARY,)
        if kind=='friends' and other['gender']!='woman':patterns+=(FRIEND_FEMALE_PREFERENCE,)
        hits=sorted({m.group(0).lower() for pattern in patterns for m in pattern.finditer(text)})
        if hits: result.append({'user_id':p['user_id'],'terms':hits,'answer':text,'status':'needs_text_boundary_review'})
    return result

def validate_review_decisions(people,policy):
    """A text review applies only to the exact two profiles that were reviewed."""
    for pair,decision in policy.get('manual_pair_decisions',{}).items():
        parts=pair.split('|')
        if len(parts)!=3 or parts[0] not in KINDS or parts[1]==parts[2]:
            raise ValueError('Invalid reviewed pair key')
        if decision.get('decision') not in ('clear','exclude') or not decision.get('rationale'):
            raise ValueError('Reviewed pair needs a decision and evidence-based rationale')
        expected={u:digest(people[u]) for u in parts[1:] if u in people}
        if len(expected)!=2 or expected!=decision.get('profile_sha256'):
            raise ValueError('Stale or missing profile evidence for reviewed pair '+pair)

def coverage_objective_names(policy):
    if not policy.get('coverage_first'):return []
    names=['members_with_unflagged_proposal','members_with_any_proposal']
    return list(reversed(names)) if policy.get('prioritize_any_introduction') else names

def objective_names(policy):
    first=coverage_objective_names(policy)
    return first+['previously_without_romance','introductions','fit_score']

def edge_objectives(edge,policy):
    counts={'members_with_unflagged_proposal':0 if edge.get('boundary_review_required') else 2,'members_with_any_proposal':2}
    first=[counts[name] for name in coverage_objective_names(policy)]
    return first+[edge['priority_people'],1,edge['score_integer']]

def selected_objectives(edges,selected,policy):
    rows=[edges[i] for i in selected]
    counts={'members_with_unflagged_proposal':len({u for e in rows if not e.get('boundary_review_required') for u in (e['a'],e['b'])}),
            'members_with_any_proposal':len({u for e in rows for u in (e['a'],e['b'])})}
    first=[counts[name] for name in coverage_objective_names(policy)]
    priority=len({u for e in rows for u in e.get('priority_user_ids',[])})+sum(e['priority_people'] for e in rows if 'priority_user_ids' not in e)
    return first+[priority,len(rows),sum(e['score_integer'] for e in rows)]

def allocation_valid(edges,selected,policy):
    """Check all conditions, including effects on an existing partner's sole match."""
    rows=[edges[i] for i in selected]
    counts=collections.Counter((u,e['type']) for e in rows for u in (e['a'],e['b']))
    totals=collections.Counter(u for e in rows for u in (e['a'],e['b']))
    if any(n>policy['max_per_type'] for n in counts.values()) or any(n>policy['max_total'] for n in totals.values()):return False
    if len({pair_key(e['a'],e['b']) for e in rows})!=len(rows):return False
    if any(totals[e['a']]!=1 and totals[e['b']]!=1 for e in rows if e.get('friendship_age_gap_exception')):return False
    if any(not any(totals[u]==1 for u in e['rescue_target_user_ids']) for e in rows if e.get('first_introduction_rescue')):return False
    if policy.get('second_intro_only_for_first_match'):
        credits=collections.Counter((u,e['type']) for e in rows for u,other in ((e['a'],e['b']),(e['b'],e['a'])) if totals[other]==1)
        if any(credits[slot]<n-1 for slot,n in counts.items()):return False
    return True

def augment_coverage_hint(edges,chosen,policy):
    """Deterministic feasible additions; the solver still optimizes the full graph."""
    chosen=set(chosen);totals=collections.Counter(u for i in chosen for u in (edges[i]['a'],edges[i]['b']))
    degrees=collections.Counter(u for e in edges for u in (e['a'],e['b']))
    slots=collections.Counter((u,edges[i]['type']) for i in chosen for u in (edges[i]['a'],edges[i]['b']))
    order=sorted(range(len(edges)),key=lambda i:(
        -sum(totals[u]==0 for u in (edges[i]['a'],edges[i]['b'])),
        min((degrees[u] for u in (edges[i]['a'],edges[i]['b']) if not totals[u]),default=len(edges)+1),
        bool(edges[i].get('boundary_review_required')),-edges[i]['score_integer'],i))
    for i in order:
        e=edges[i];users=(e['a'],e['b'])
        if i in chosen or all(totals[u] for u in users):continue
        if any(totals[u]>=policy['max_total'] or slots[(u,e['type'])]>=policy['max_per_type'] for u in users):continue
        if allocation_valid(edges,chosen|{i},policy):
            chosen.add(i)
            for u in users:totals[u]+=1;slots[(u,e['type'])]+=1
    return sorted(chosen)

def repair_coverage(edges,selected,policy):
    """Add or replace one edge to cover someone new, never uncovering anyone.

    Each accepted move strictly increases unique coverage. All allocation rules
    are checked against the entire resulting plan, including remote sole-match
    dependencies. This finite local search is not a global optimality proof.
    """
    chosen=set(selected);moves=[]
    degrees=collections.Counter(u for e in edges for u in (e['a'],e['b']))
    while True:
        adjacency=collections.defaultdict(set)
        for i in chosen:
            for u in (edges[i]['a'],edges[i]['b']):adjacency[u].add(i)
        candidates=[i for i,e in enumerate(edges) if i not in chosen and not all(adjacency[u] for u in (e['a'],e['b']))]
        candidates.sort(key=lambda i:(-sum(not adjacency[u] for u in (edges[i]['a'],edges[i]['b'])),
                                     min(degrees[u] for u in (edges[i]['a'],edges[i]['b']) if not adjacency[u]),
                                     bool(edges[i].get('boundary_review_required')),-edges[i]['score_integer'],i))
        found=False
        for i in candidates:
            e=edges[i];endpoints={e['a'],e['b']}
            removals=[None]+sorted(adjacency[e['a']]|adjacency[e['b']],key=lambda j:(edges[j]['score_integer'],j))
            for old in removals:
                if old is not None and any(len(adjacency[u])==1 and u not in endpoints for u in (edges[old]['a'],edges[old]['b'])):continue
                trial=(chosen-({old} if old is not None else set()))|{i}
                if not allocation_valid(edges,trial,policy):continue
                moves.append({'added_index':i,'removed_index':old});chosen=trial;found=True;break
            if found:break
        if not found:break
    return sorted(chosen),moves

def optimize_component(edges,policy):
    if not edges: return [],[]
    model=cp_model.CpModel(); variables=[model.NewBoolVar('e'+str(i)) for i in range(len(edges))]
    per_type=collections.defaultdict(list); per_user=collections.defaultdict(list); per_pair=collections.defaultdict(list);per_user_ready=collections.defaultdict(list)
    for i,e in enumerate(edges):
        for u in (e['a'],e['b']):
            per_type[(u,e['type'])].append(variables[i]);per_user[u].append(variables[i])
            if not e.get('boundary_review_required'):per_user_ready[u].append(variables[i])
        per_pair[pair_key(e['a'],e['b'])].append(variables[i])
    for group in per_type.values(): model.Add(sum(group)<=policy['max_per_type'])
    for group in per_user.values(): model.Add(sum(group)<=policy['max_total'])
    for group in per_pair.values(): model.Add(sum(group)<=1)
    indicators=[]
    wider_users={u for e in edges if e.get('friendship_age_gap_exception') or e.get('first_introduction_rescue') for u in (e['a'],e['b'])}
    if policy.get('second_intro_only_for_first_match'):wider_users.update(per_user)
    singles={}
    for u in sorted(wider_users):
        single=model.NewBoolVar('sole_introduction_'+u);group=per_user[u]
        model.Add(sum(group)==1).OnlyEnforceIf(single);model.Add(sum(group)!=1).OnlyEnforceIf(single.Not())
        singles[u]=single;indicators.append((single,group,'single'))
    for e,v in zip(edges,variables):
        if e.get('friendship_age_gap_exception'):model.Add(v<=singles[e['a']]+singles[e['b']])
        if e.get('first_introduction_rescue'):model.Add(v<=sum(singles[u] for u in e['rescue_target_user_ids']))
    credit_indicators=[]
    if policy.get('second_intro_only_for_first_match'):
        credits=collections.defaultdict(list)
        for i,(e,v) in enumerate(zip(edges,variables)):
            for u,other in ((e['a'],e['b']),(e['b'],e['a'])):
                credit=model.NewBoolVar('first_match_credit_'+str(i)+'_'+u)
                model.Add(credit<=v);model.Add(credit<=singles[other]);model.Add(credit>=v+singles[other]-1)
                credits[(u,e['type'])].append(credit);credit_indicators.append((credit,i,other))
        for slot,group in per_type.items():model.Add(sum(credits[slot])>=sum(group)-1)
    priority_terms=[e['priority_people']*v for e,v in zip(edges,variables) if 'priority_user_ids' not in e]
    priority_groups=collections.defaultdict(list)
    for e,v in zip(edges,variables):
        for u in e.get('priority_user_ids',[]):priority_groups[u].append(v)
    for u,group in sorted(priority_groups.items()):
        y=model.NewBoolVar('previously_without_romance_'+u)
        model.Add(sum(group)>=y);model.Add(sum(group)<=policy['max_per_type']*y)
        indicators.append((y,group,'any'));priority_terms.append(y)
    priority=sum(priority_terms)
    coverage=sum(variables); quality=sum(e['score_integer']*v for e,v in zip(edges,variables))
    objectives=[priority,coverage,quality]
    if policy.get('coverage_first'):
        seen=[];unflagged=[]
        for u,group in sorted(per_user.items()):
            y=model.NewBoolVar('covered_'+u);model.Add(sum(group)>=y);model.Add(sum(group)<=policy['max_total']*y);seen.append(y)
            ready=per_user_ready[u]
            z=model.NewBoolVar('unflagged_'+u);model.Add(sum(ready)>=z);model.Add(sum(ready)<=policy['max_total']*z);unflagged.append(z)
            indicators.extend(((y,group,'any'),(z,ready,'any')))
        coverage_values={'members_with_unflagged_proposal':sum(unflagged),'members_with_any_proposal':sum(seen)}
        objectives=[coverage_values[name] for name in coverage_objective_names(policy)]+objectives
    stages=[]; chosen=[]
    hints=set(policy.get('warm_start_pairs',[]))
    chosen=[i for i,e in enumerate(edges) if e['type']+'|'+pair_key(e['a'],e['b']) in hints]
    initial_rows=[edges[i] for i in chosen]
    initial_types=collections.Counter((u,e['type']) for e in initial_rows for u in (e['a'],e['b']))
    initial_totals=collections.Counter(u for e in initial_rows for u in (e['a'],e['b']))
    if (any(n>policy['max_per_type'] for n in initial_types.values())
        or any(n>policy['max_total'] for n in initial_totals.values())
        or len({pair_key(e['a'],e['b']) for e in initial_rows})!=len(initial_rows)
        or any(initial_totals[e['a']]!=1 and initial_totals[e['b']]!=1 for e in initial_rows if e.get('friendship_age_gap_exception'))):
        raise ValueError('Warm start violates allocation constraints')
    if any(not any(initial_totals[u]==1 for u in e['rescue_target_user_ids']) for e in initial_rows if e.get('first_introduction_rescue')):
        raise ValueError('Warm start violates first-introduction rescue rule')
    initial_credits=collections.Counter((u,e['type']) for e in initial_rows for u,other in ((e['a'],e['b']),(e['b'],e['a'])) if initial_totals[other]==1)
    if policy.get('second_intro_only_for_first_match') and any(initial_credits[slot]<n-1 for slot,n in initial_types.items()):raise ValueError('Warm start second introductions do not serve sole-introduction recipients')
    if policy.get('augment_coverage_hint'):chosen=augment_coverage_hint(edges,chosen,policy)
    def add_hints(selected):
        model.ClearHints();selected=set(selected)
        for i,v in enumerate(variables):model.AddHint(v,int(i in selected))
        for v,group,kind in indicators:
            count=sum(x.Index() in selected for x in group);model.AddHint(v,int(count==1 if kind=='single' else count>1 if kind=='multiple' else count>0))
        totals=collections.Counter(u for i in selected for u in (edges[i]['a'],edges[i]['b']))
        for v,i,other in credit_indicators:model.AddHint(v,int(i in selected and totals[other]==1))
    if hints or chosen:add_hints(chosen)
    for stage_index,(label,objective) in enumerate(zip(objective_names(policy),objectives)):
        model.Add(objective>=selected_objectives(edges,chosen,policy)[stage_index])
        model.Maximize(objective);solver=cp_model.CpSolver()
        solver.parameters.num_search_workers=1;solver.parameters.random_seed=policy['seed']
        solver.parameters.max_deterministic_time=policy.get('deterministic_time_by_stage',{}).get(label,policy.get('max_deterministic_time',60))
        if policy.get('presolve_all_stages') is False or (stage_index and policy.get('skip_later_presolve') and len(edges)>1000):solver.parameters.cp_model_presolve=False
        status=solver.Solve(model)
        retained=False;retained_lexicographic=False
        if status in (cp_model.OPTIMAL,cp_model.FEASIBLE):
            value=int(round(solver.ObjectiveValue()));proposal=[i for i,v in enumerate(variables) if solver.Value(v)];bound=solver.BestObjectiveBound()
            # A stage may tie its primary objective while worsening later ones.
            # Keep the known feasible incumbent when it is lexicographically better.
            if selected_objectives(edges,chosen,policy)>selected_objectives(edges,proposal,policy):retained_lexicographic=True
            else:chosen=proposal
        elif status==cp_model.UNKNOWN:
            # The preceding solution satisfies every fixed objective. Keep it if
            # a later stage exhausts its work allowance before finding a solution.
            retained=True;value=selected_objectives(edges,chosen,policy)[stage_index]
            max_pairs=min(len(edges),len(per_user)*policy['max_total']//2)
            bound=sum(sorted((e['score_integer'] for e in edges),reverse=True)[:max_pairs]) if label=='fit_score' else max_pairs if label=='introductions' else len(per_user)
        else:raise RuntimeError('Allocation failed: '+solver.StatusName(status))
        stages.append({'stage':label,'status':'FEASIBLE' if retained else solver.StatusName(status),'objective':value,'best_bound':bound,
                       'solver_status':solver.StatusName(status),'retained_previous_solution':retained,
                       'retained_lexicographic_incumbent':retained_lexicographic,
                       'deterministic_time':solver.ResponseProto().deterministic_time,'wall_seconds':round(solver.WallTime(),3)})
        if policy.get('coverage_first'):print(json.dumps({'component_edges':len(edges),**stages[-1]}),flush=True)
        if policy.get('_checkpoint_dir'):
            component=digest([(e['type'],e['a'],e['b']) for e in edges])[:16]
            write(Path(policy['_checkpoint_dir'])/(component+'-'+label+'.json'),{'stage':stages[-1],
                  'selected_pairs':[[edges[i]['type'],edges[i]['a'],edges[i]['b']] for i in chosen]})
        model.Add(objective==value)
        add_hints(chosen)
    return chosen,stages

def optimize(edges,policy):
    """Solve independent constraint components; exact blossom for single-type groups."""
    if not edges:return [],[]
    import networkx as nx
    parent={}
    def root(x):
        parent.setdefault(x,x)
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    def union(a,b):
        a,b=root(a),root(b)
        if a!=b:parent[max(a,b)]=min(a,b)
    pairs=collections.defaultdict(list);user_slots=collections.defaultdict(set)
    for e in edges:
        a,b=(e['a'],e['type']),(e['b'],e['type']);union(a,b)
        pairs[pair_key(e['a'],e['b'])].append(a);user_slots[e['a']].add(a);user_slots[e['b']].add(b)
    for slots in pairs.values():
        for s in slots[1:]:union(slots[0],s)
    for slots in user_slots.values():
        if policy.get('coverage_first') or len(slots)*policy['max_per_type']>policy['max_total']:
            ordered=sorted(slots)
            for s in ordered[1:]:union(ordered[0],s)
    groups=collections.defaultdict(list)
    for i,e in enumerate(edges):groups[root((e['a'],e['type']))].append(i)
    chosen=[];all_stages=[];algorithms=collections.Counter();started=time.monotonic()
    for ids in sorted(groups.values(),key=lambda xs:xs[0]):
        component=[edges[i] for i in ids]
        if len({e['type'] for e in component})==1 and policy['max_per_type']==1:
            algorithms['exact_integer_graph_matching']+=1
            nodes=sorted({u for e in component for u in (e['a'],e['b'])});capacity=len(nodes)//2
            contributions=[edge_objectives(e,policy) for e in component];weights=[];bound=0
            for stage in reversed(range(len(objective_names(policy)))):
                weight=bound+1;weights.insert(0,weight);bound+=capacity*max(c[stage] for c in contributions)*weight
            graph=nx.Graph();graph.add_nodes_from(nodes);lookup={}
            for index,e in enumerate(component):
                graph.add_edge(e['a'],e['b'],weight=sum(x*w for x,w in zip(contributions[index],weights)))
                lookup[pair_key(e['a'],e['b'])]=index
            selected=sorted(lookup[pair_key(*p)] for p in nx.max_weight_matching(graph))
            values=[sum(contributions[i][stage] for i in selected) for stage in range(len(weights))]
            stages=[{'stage':name,'status':'OPTIMAL','objective':value,'best_bound':float(value),'deterministic_time':0,'wall_seconds':0}
                    for name,value in zip(objective_names(policy),values)]
        else:
            algorithms['cp_sat']+=1;selected,stages=optimize_component(component,policy)
        chosen.extend(ids[i] for i in selected);all_stages.append(stages)
    result=[]
    for i,name in enumerate(objective_names(policy)):
        rows=[s[i] for s in all_stages]
        result.append({'stage':name,'status':'OPTIMAL' if all(r['status']=='OPTIMAL' for r in rows) else 'FEASIBLE',
                       'objective':sum(r['objective'] for r in rows),'best_bound':sum(r['best_bound'] for r in rows),
                       'deterministic_time':sum(r['deterministic_time'] for r in rows),'wall_seconds':round(sum(r['wall_seconds'] for r in rows),3),
                       'retained_previous_components':sum(bool(r.get('retained_previous_solution')) for r in rows),
                       'components':len(groups),'algorithms':dict(algorithms)})
    print(json.dumps({'allocation_stages':result,'allocation_seconds':round(time.monotonic()-started,3)}),flush=True)
    return sorted(chosen),result

class Matcher:
    def __init__(self,run_dir):
        self.directory=Path(run_dir); self.snapshot=json.loads((self.directory/'snapshot.json').read_text())
        self.policy=json.loads((self.directory/'policy.json').read_text());self.books=json.loads((self.directory/'books.json').read_text())
        self.people={p['user_id']:p for p in self.snapshot['profiles']}
        self.requested_pairs=validate_requested_pairs(self.people,self.policy)
        self.gate_policy={**self.policy,'_metro_pairs':{tuple(x) for x in self.policy.get('verified_metro_city_pairs',[])},
                          '_country_pairs':{tuple(sorted(x)) for x in self.policy.get('blocked_country_pairs',[])},
                          '_requested_reservations':requested_reservations(self.policy)}
        self.aliases=json.loads((self.directory/'aliases.json').read_text());self.model=json.loads((self.directory/'model.json').read_text())
        if digest(self.books)!=self.model['books_sha256']: raise ValueError('Book metadata changed since embeddings')
        raw=(self.directory/'book-vectors.npy').read_bytes()
        if hashlib.sha256(raw).hexdigest()!=self.model['vectors_sha256']: raise ValueError('Embedding checksum mismatch')
        self.ids=self.model['ids']; self.index={v:i for i,v in enumerate(self.ids)}
        vectors=np.load(self.directory/'book-vectors.npy',allow_pickle=False)
        self.semantic=np.round(np.clip((vectors@vectors.T-.15)/.65,0,1),6)
        self.sim=self.semantic.copy()
        genres=sorted({g for b in self.books.values() for g in b['genres']})
        genre_matrix=np.array([[float(g in self.books[i]['genres']) for g in genres] for i in self.ids],dtype=np.float32)
        intersection=genre_matrix@genre_matrix.T;genre_counts=genre_matrix.sum(axis=1)
        union=genre_counts[:,None]+genre_counts[None,:]-intersection
        genre_floor=np.where(intersection>0,.5+.1*intersection/np.maximum(1,union),0)
        self.sim=np.maximum(self.sim,genre_floor)
        adequate=np.array([self.books[i]['metadata_adequate'] for i in self.ids])
        self.semantic[~adequate,:]=0;self.semantic[:,~adequate]=0
        self.sim[~adequate,:]=0;self.sim[:,~adequate]=0
        author_groups=collections.defaultdict(list)
        for i,bid in enumerate(self.ids):
            author=key(self.books[bid]['author'])
            if author not in ('','unknown','unknownauthor'):author_groups[author].append(i)
        for group in author_groups.values():
            ix=np.ix_(group,group);self.sim[ix]=np.maximum(self.sim[ix],.75)
        np.fill_diagonal(self.sim,1.);np.fill_diagonal(self.semantic,1.)
        self.excluded,self.identity_decisions=exclusions(self.snapshot,self.policy)
        self.people={p['user_id']:p for p in self.snapshot['profiles']}
        validate_review_decisions(self.people,self.policy)
        self.active=sorted((p for p in self.snapshot['profiles'] if p['user_id'] not in self.excluded),key=lambda p:p['user_id'])
        self.previous,self.previous_romance,self.previous_recs=history_data(self.snapshot)
        # Deleted members may remove historical joins; the original release remains evidence of prior introductions.
        for pair in self.policy.get('historical_pairs',[]): self.previous.add(pair_key(*pair))
        self.previous_romance.update(self.policy.get('historical_romance_user_ids',[]))
        self.identity_map={d['suppressed']:d['retained'] for d in self.identity_decisions}
        self.identity_map.update(self.policy.get('historical_identity_map',{}))
        def canonical_person(user):
            seen=set()
            while user in self.identity_map and user not in seen:
                seen.add(user);user=self.identity_map[user]
            return user
        self.previous|={pair_key(*(canonical_person(x) for x in pair.split('|'))) for pair in list(self.previous)}
        self.previous_romance|={canonical_person(x) for x in list(self.previous_romance)}
        self.priority_romance={canonical_person(x) for x in self.policy.get('priority_romance_user_ids',[])}-self.previous_romance
        for user,ids in list(self.previous_recs.items()):self.previous_recs[canonical_person(user)].update(ids)
        for user,ids in self.policy.get('historical_recommendations_by_user',{}).items():self.previous_recs[canonical_person(user)].update(ids)
        self.blocked={pair_key(x['blocker_id'],x['blocked_id']) for x in self.snapshot.get('blocks',[])}
        self.blocked|={pair_key(*(canonical_person(x) for x in pair.split('|'))) for pair in list(self.blocked)}
        validate_requested_eligibility(self.people,self.gate_policy,self.excluded,self.previous,self.blocked)
        self.shelves={};self.activity={};self.authors={};self.person_genres={};self.read_books=collections.defaultdict(set)
        for p in self.active:
            u=p['user_id']; shelf=sorted({self.aliases.get(b['id'],b['id']) for b in p['favorites']})
            self.shelves[u]=shelf;self.authors[u]={key(b['author']) for b in p['favorites'] if key(b['author']) not in ('','unknown','unknownauthor')}
            self.person_genres[u]={g for bid in shelf if self.books[bid]['metadata_adequate'] for g in self.books[bid]['genres']}
            self.activity[u]=tags(p.get('friendship_interests',''))
            self.read_books[u].update(shelf)
            if p.get('currently_reading'): self.read_books[u].add(self.aliases.get(p['currently_reading']['id'],p['currently_reading']['id']))
            self.read_books[u].update(self.aliases.get(i,i) for i in self.previous_recs[u])
        for row in self.snapshot.get('library',[]): self.read_books[canonical_person(row['user_id'])].add(self.aliases.get(row['work_id'],row['work_id']))
        self.person_affinity={}
        for p in self.active:
            matrix=self.sim[[self.index[b] for b in self.shelves[p['user_id']]],:]
            self.person_affinity[p['user_id']]=.7*matrix.max(axis=0)+.3*matrix.mean(axis=0)
        self.gates=collections.defaultdict(collections.Counter)
        self.structural_candidates=collections.Counter()
        self.candidates_per_person=collections.Counter(); self.top_alternatives=collections.defaultdict(list)

    def book_fit(self,a,b):
        aa,bb=self.shelves[a],self.shelves[b]
        matrix=self.sim[np.ix_([self.index[i] for i in aa],[self.index[i] for i in bb])]
        shelf_affinity=float((matrix.max(axis=0).mean()+matrix.max(axis=1).mean())/2)
        raw=self.semantic[np.ix_([self.index[i] for i in aa],[self.index[i] for i in bb])]
        semantic=float((raw.max(axis=0).mean()+raw.max(axis=1).mean())/2)
        shared=sorted(set(aa)&set(bb)); authors=sorted(self.authors[a]&self.authors[b])
        exact=min(1,sum(1/math.sqrt(1+math.log1p(self.books[i]['frequency'])) for i in shared))
        author=min(1,len(authors)/max(1,min(len(self.authors[a]),len(self.authors[b]))))
        baseline=max(exact,.65*author)
        fit=max(.85*shelf_affinity+.10*exact+.05*author,baseline)
        idx=np.unravel_index(np.argmax(matrix),matrix.shape)
        return round(fit,6),{'semantic':round(semantic,6),'shelf_affinity':round(shelf_affinity,6),'exact_overlap':shared,'author_overlap':authors,'baseline':round(baseline,6),
                             'strongest_book_pair':[aa[idx[0]],bb[idx[1]]],'strongest_similarity':float(matrix[idx])}

    def reading_fit_matrix(self,variant='embeddings'):
        """Vectorized all-person shelf fit; selected edges are recomputed in detail."""
        ids=[p['user_id'] for p in self.active];n=len(ids);width=max(map(len,self.shelves.values()),default=0)
        shelves=np.full((n,width),-1,dtype=np.int32)
        for i,u in enumerate(ids):shelves[i,:len(self.shelves[u])]=[self.index[b] for b in self.shelves[u]]
        sizes=(shelves>=0).sum(axis=1);row_mean=np.zeros((n,n),dtype=np.float64)
        exact=np.zeros((n,n),dtype=np.float64)
        weights=np.array([1/math.sqrt(1+math.log1p(self.books[b]['frequency'])) for b in self.ids])
        for i in range(width):
            best=np.zeros((n,n));shared=np.zeros((n,n),dtype=bool);left=shelves[:,i]
            for j in range(width):
                right=shelves[:,j];valid=(left[:,None]>=0)&(right[None,:]>=0)
                values=np.where(valid,self.sim[left[:,None],right[None,:]],0)
                np.maximum(best,values,out=best);shared|=valid&(left[:,None]==right[None,:])
            row_mean+=best;exact+=shared*weights[left][:,None]
        del best,shared,values,valid
        row_mean/=np.maximum(sizes,1)[:,None];shelf=(row_mean+row_mean.T)/2;del row_mean
        np.minimum(exact,1,out=exact)
        authors=sorted({a for values in self.authors.values() for a in values});author_index={a:i for i,a in enumerate(authors)}
        author_width=max(map(len,self.authors.values()),default=0);author_ids=np.full((n,author_width),-1,dtype=np.int32)
        for i,u in enumerate(ids):author_ids[i,:len(self.authors[u])]=[author_index[a] for a in sorted(self.authors[u])]
        common=np.zeros((n,n),dtype=np.uint8)
        for i in range(author_width):
            left=author_ids[:,i];shared=np.zeros((n,n),dtype=bool)
            for j in range(author_width):shared|=(left[:,None]>=0)&(author_ids[None,:,j]>=0)&(left[:,None]==author_ids[None,:,j])
            common+=shared
        counts=(author_ids>=0).sum(axis=1);author=common/np.maximum(1,np.minimum(counts[:,None],counts[None,:]))
        baseline=np.maximum(exact,.65*author)
        fit=baseline if variant=='baseline' else np.maximum(.85*shelf+.10*exact+.05*author,baseline)
        return {u:i for i,u in enumerate(ids)},np.round(fit,6)

    def candidates(self,variant='embeddings'):
        result=self.coverage_candidates(variant) if self.policy.get('allow_weak_first_introduction') else self.legacy_candidates(variant)
        validate_requested_edges(result[0],self.policy,'retained candidate graph')
        return result

    def coverage_candidates(self,variant='embeddings'):
        from edge_cover import SparseCollector
        started=time.monotonic();index,fits=self.reading_fit_matrix(variant);counts=collections.Counter()
        collector=SparseCollector(self.policy.get('sparse_quality_k',32),self.policy.get('sparse_exploration_k',12))
        fake={'user_id':'_empty','gender':'woman','romance_ideal_match':'','friendship_interests':''}
        genders={p['gender'] for p in self.active}
        flags={(p['user_id'],k,g):bool(constraint_flags(p,{**fake,'gender':g},k)) for p in self.active for k in ('romance','friends') for g in genders}
        offered={p['user_id']:tags(p.get('business_skills',''),SKILLS) for p in self.active}
        seeking={p['user_id']:tags(p.get('business_seeking',''),SKILLS) for p in self.active}
        for kind in KINDS:
            pool=[p for p in self.active if kind in p['intents']]
            for a,b in itertools.combinations(pool,2):
                u,v=a['user_id'],b['user_id'];reason=eligible(a,b,kind,self.gate_policy,self.previous,self.blocked)
                decision=self.policy.get('manual_pair_decisions',{}).get(kind+'|'+pair_key(u,v))
                if not reason and decision and decision['decision']=='exclude':reason='reviewed_written_boundary'
                if reason:
                    self.gates[(u,kind)][reason]+=1;self.gates[(v,kind)][reason]+=1;counts[reason]+=1;continue
                self.structural_candidates[(u,kind)]+=1;self.structural_candidates[(v,kind)]+=1
                self.candidates_per_person[(u,kind)]+=1;self.candidates_per_person[(v,kind)]+=1
                fit=float(fits[index[u],index[v]]);gap=abs(a['age']-b['age'])
                activity=len(self.activity[u]&self.activity[v])/min(len(self.activity[u]),len(self.activity[v])) if self.activity[u] and self.activity[v] else None
                ab=offered[u]&seeking[v];ba=offered[v]&seeking[u];business=min(1,(len(ab)+len(ba))/4) if ab and ba else 0
                score=round(sum(books_age_components(kind,fit,activity,gap,self.policy,business).values()),6)
                flagged=bool(kind in ('romance','friends') and (flags[(u,kind,b['gender'])] or flags[(v,kind,a['gender'])]) and not(decision and decision['decision']=='clear'))
                collector.add({'a':u,'b':v,'type':kind,'score':score,'score_integer':int(round(score*10000)),
                               'age_gap_years':gap,'boundary_review_required':flagged,
                               'priority_people':sum(x in self.priority_romance for x in (u,v)) if kind=='romance' else 0})
                counts[kind]+=1
            print(json.dumps({'candidate_type':kind,'screened_edges_so_far':collector.edges_seen,'elapsed_seconds':round(time.monotonic()-started,1)}),flush=True)
        small,report=collector.finish();self.sparsification=report;self.hard_eligible_users=sorted(collector.degrees)
        del fits
        edges=[]
        for short in small:
            a,b=self.people[short['a']],self.people[short['b']];u,v=short['a'],short['b'];kind=short['type']
            fit,book=self.book_fit(u,v)
            if variant=='baseline':fit=book['baseline']
            shared=sorted(self.activity[u]&self.activity[v]);genres=sorted(self.person_genres[u]&self.person_genres[v]);gap=short['age_gap_years']
            activity=len(shared)/min(len(self.activity[u]),len(self.activity[v])) if self.activity[u] and self.activity[v] else None
            ab=offered[u]&seeking[v];ba=offered[v]&seeking[u];business=min(1,(len(ab)+len(ba))/4) if ab and ba else 0
            parts=books_age_components(kind,fit,activity,gap,self.policy,business);score=round(sum(parts.values()),6)
            if abs(score-short['score'])>2e-6:raise AssertionError('Vectorized and detailed scoring disagree')
            age_limit=self.policy.get('standard_friendship_age_gap_under_25',5) if min(a['age'],b['age'])<25 else self.policy.get('standard_friendship_age_gap_other',8)
            age_exception=kind=='friends' and gap>age_limit
            standard_threshold=self.policy.get('standard_candidate_thresholds',self.policy['candidate_thresholds'])[kind]
            standard=score>=standard_threshold and fit>=self.policy.get('standard_minimum_book_support',.30) and not age_exception
            reading=fit>=self.policy['minimum_book_support'] and score>=self.policy['candidate_thresholds'][kind] and (standard or bool(book['exact_overlap'] or book['author_overlap'] or genres or shared))
            activity_route=bool(kind=='friends' and len(shared)>=2 and set(shared)-{'coffee','bookshops','reading together'} and score>=self.policy.get('local_activity_friendship_threshold',.30))
            if kind=='business_partners' and not(ab and ba):reading=False
            weak=not(reading or activity_route);same_metro=a['city_id']==b['city_id'] or tuple(sorted([a['city_id'],b['city_id']])) in self.gate_policy['_metro_pairs']
            edge={**short,'score':score,'score_integer':int(round(score*10000)),'book_fit':fit,'book_evidence':book,
                  **requested_edge_fields(u,v,kind,self.policy),
                  'threshold':0 if weak else self.policy['candidate_thresholds'][kind] if reading else self.policy.get('local_activity_friendship_threshold',.30),
                  'score_components':{k:round(x,6) for k,x in parts.items()},'distance_km':round(km(a,b),2),
                  'shared_activities':shared,'shared_genres':genres,'standard_threshold':standard_threshold,
                  'quality_tier':'weak_first_introduction' if weak else 'standard' if standard else 'broader_first_introduction',
                  'evidence_route':'coverage_first_weak_evidence' if weak else 'reading' if reading else 'shared_activities',
                  'first_introduction_rescue':weak,'rescue_target_user_ids':[],
                  'rescue_basis':['owner_authorized_weak_fit_first_introduction'] if weak else [],
                  'friendship_age_gap_exception':age_exception,
                  'location_preference_exception_user_ids':sorted(p['user_id'] for p in (a,b) if p['location_preference']=='same_city' and not same_metro),
                  'business_evidence':{'a_offers_b_seeks':sorted(ab),'b_offers_a_seeks':sorted(ba)} if kind=='business_partners' else {},
                  'priority_user_ids':sorted({u,v}&self.priority_romance) if kind=='romance' else []}
            edges.append(edge)
            for x,y in ((u,v),(v,u)):self.top_alternatives[(x,kind)].append({'other':y,'score':score,'distance_km':edge['distance_km']})
        for k in self.top_alternatives:self.top_alternatives[k]=sorted(self.top_alternatives[k],key=lambda e:(-e['score'],e['other']))[:5]
        return sorted(edges,key=lambda e:(KINDS.index(e['type']),e['a'],e['b'])),dict(counts)

    def legacy_candidates(self,variant='embeddings'):
        edges=[];counts=collections.Counter(); started=time.monotonic()
        rescue_users=set(self.policy.get('coverage_rescue_user_ids',[]))
        pool={k:[p for p in self.active if k in p['intents']] for k in KINDS}
        for kind in KINDS:
            for a,b in itertools.combinations(pool[kind],2):
                reason=eligible(a,b,kind,self.gate_policy,self.previous,self.blocked)
                if reason:
                    self.gates[(a['user_id'],kind)][reason]+=1;self.gates[(b['user_id'],kind)][reason]+=1;counts[reason]+=1;continue
                u,v=a['user_id'],b['user_id'];distance=km(a,b)
                self.structural_candidates[(u,kind)]+=1;self.structural_candidates[(v,kind)]+=1
                fit,book=self.book_fit(u,v)
                if variant=='baseline': fit=book['baseline']
                shared_activities=sorted(self.activity[u]&self.activity[v])
                activity=len(shared_activities)/max(1,min(len(self.activity[u]),len(self.activity[v]))) if self.activity[u] and self.activity[v] else None
                shared_genres=sorted(self.person_genres[u]&self.person_genres[v])
                same_metro=a['city_id']==b['city_id'] or tuple(sorted([a['city_id'],b['city_id']])) in self.gate_policy['_metro_pairs']
                activity_route=bool(self.policy.get('allow_local_activity_friendship') and kind=='friends' and same_metro and distance<=75
                                    and len(shared_activities)>=2 and set(shared_activities)-{'coffee','bookshops','reading together'})
                age_gap=abs(a['age']-b['age'])
                standard_age_limit=self.policy.get('standard_friendship_age_gap_under_25',self.policy['friendship_age_gap_under_25']) if min(a['age'],b['age'])<25 else self.policy.get('standard_friendship_age_gap_other',self.policy['friendship_age_gap_other'])
                age_exception=kind=='friends' and age_gap>standard_age_limit
                if age_exception and fit<self.policy.get('standard_minimum_book_support',.30) and not activity_route:
                    reason='insufficient_evidence_for_wider_friendship_age_gap'
                    self.gates[(u,kind)][reason]+=1;self.gates[(v,kind)][reason]+=1;counts[reason]+=1;continue
                if fit<min(self.policy['minimum_book_support'],self.policy.get('first_introduction_reading_rule',{}).get('minimum_book_fit',1)) and not activity_route:
                    reason='insufficient_book_evidence'
                    self.gates[(u,kind)][reason]+=1;self.gates[(v,kind)][reason]+=1;counts[reason]+=1;continue
                business=None;skill_evidence={}
                if kind=='business_partners':
                    ab=tags(a.get('business_skills',''),SKILLS)&tags(b.get('business_seeking',''),SKILLS)
                    ba=tags(b.get('business_skills',''),SKILLS)&tags(a.get('business_seeking',''),SKILLS)
                    skill_evidence={'a_offers_b_seeks':sorted(ab),'b_offers_a_seeks':sorted(ba)}
                    if not ab or not ba:
                        reason='insufficient_reciprocal_business_evidence'
                        self.gates[(u,kind)][reason]+=1;self.gates[(v,kind)][reason]+=1;counts[reason]+=1;continue
                    business=min(1,(len(ab)+len(ba))/4)
                distance_free=all(p['location_preference'] in ('anywhere','radius') for p in (a,b))
                parts=books_age_components(kind,fit,activity,age_gap,self.policy,business) if distance_free else score_components(kind,fit,activity,location_fit(distance),business)
                score=round(sum(parts.values()),6);threshold=threshold_for(kind,0 if distance_free else distance,self.policy)
                standard_threshold=self.policy.get('standard_candidate_thresholds',self.policy['candidate_thresholds'])[kind]+(0 if distance_free else .10 if distance>1000 else .05 if distance>250 else 0)
                standard=score>=standard_threshold and fit>=self.policy.get('standard_minimum_book_support',self.policy['minimum_book_support']) and not age_exception
                explicit_overlap=bool(book['exact_overlap'] or book['author_overlap'] or shared_genres or shared_activities)
                reading_qualified=fit>=self.policy['minimum_book_support'] and score>=threshold and (not self.policy.get('coverage_first') or standard or explicit_overlap)
                activity_qualified=activity_route and score>=self.policy.get('local_activity_friendship_threshold',.30)
                rescue_targets=sorted({u,v}&rescue_users)
                rescue_basis=reading_rescue_basis(kind,fit,score,book,shared_genres,rescue_targets,self.policy) if not(reading_qualified or activity_qualified) else []
                if not reading_qualified and not activity_qualified and not rescue_basis:
                    self.gates[(u,kind)]['below_fit_threshold']+=1;self.gates[(v,kind)]['below_fit_threshold']+=1;counts['below_fit_threshold']+=1;continue
                if rescue_basis:threshold=self.policy['first_introduction_reading_rule']['minimum_score']
                elif not reading_qualified:threshold=self.policy['local_activity_friendship_threshold']
                pkey=kind+'|'+pair_key(u,v);decision=self.policy.get('manual_pair_decisions',{}).get(pkey)
                if decision and decision.get('decision')=='exclude':
                    self.gates[(u,kind)]['reviewed_written_boundary']+=1;self.gates[(v,kind)]['reviewed_written_boundary']+=1;continue
                edge={'a':u,'b':v,'type':kind,'score':score,'score_integer':int(round(score*10000)),
                      **requested_edge_fields(u,v,kind,self.policy),
                      'threshold':threshold,'distance_km':round(distance,2),'book_fit':fit,'book_evidence':book,
                      'score_components':{k:round(x,6) for k,x in parts.items()},'shared_activities':shared_activities,
                      'shared_genres':shared_genres,'quality_tier':'first_introduction_reading' if rescue_basis else 'standard' if standard else 'broader_first_introduction',
                      'friendship_age_gap_exception':age_exception,'age_gap_years':age_gap,
                      'first_introduction_rescue':bool(rescue_basis),'rescue_basis':rescue_basis,'rescue_target_user_ids':rescue_targets if rescue_basis else [],
                      'evidence_route':'reading_starting_point' if rescue_basis else 'reading' if reading_qualified else 'local_shared_activities','standard_threshold':standard_threshold,
                      'boundary_review_required':bool(constraint_flags(a,b,kind) and not(decision and decision.get('decision')=='clear')),
                      'business_evidence':skill_evidence,'priority_people':sum(x in self.priority_romance for x in (u,v)) if kind=='romance' else 0,
                      'priority_user_ids':sorted({u,v}&self.priority_romance) if kind=='romance' else []}
                edges.append(edge);counts[kind]+=1
                for x,y in ((u,v),(v,u)):
                    self.candidates_per_person[(x,kind)]+=1
                    self.top_alternatives[(x,kind)].append({'other':y,'score':score,'distance_km':edge['distance_km']})
            print(json.dumps({'candidate_type':kind,'edges_so_far':len(edges),'elapsed_seconds':round(time.monotonic()-started,1)}),flush=True)
        for k in self.top_alternatives: self.top_alternatives[k]=sorted(self.top_alternatives[k],key=lambda e:(-e['score'],e['other']))[:5]
        return sorted(edges,key=lambda e:(KINDS.index(e['type']),e['a'],e['b'])),dict(counts)

    def recommend(self,e):
        u,v=e['a'],e['b']; aa,bb=self.person_affinity[u],self.person_affinity[v]
        quality=np.minimum(aa,bb)*.85+(aa+bb)*.075
        forbidden=self.read_books[u]|self.read_books[v]
        forbidden_works={self.books[bid]['metadata'].get('source_work_id') for bid in forbidden if bid in self.books}-{None,''}
        read_authors={key(self.books[bid]['author']) for bid in forbidden if bid in self.books}-{key('Unknown author'),''}
        series_entries=set(self.policy.get('series_entry_recommendation_ids',[]))
        allowed=set(self.policy.get('recommendation_allowlist',[]))
        best=None
        for i in np.argsort(-quality,kind='stable'):
            bid=self.ids[i];b=self.books[bid]
            if bid not in allowed:continue
            if bid in series_entries and key(b['author']) in read_authors:continue
            if bid in forbidden or b['metadata'].get('source_work_id') in forbidden_works or not b['metadata_adequate'] or min(aa[i],bb[i])<.35: continue
            if re.search(r'\b(?:book|volume|vol\.?|#)\s*[2-9]\b',b['title'],re.I): continue
            best=int(i);break
        if best is None: return None
        bid=self.ids[best];b=self.books[bid]
        first=max(self.shelves[u],key=lambda x:(self.sim[self.index[x],best],x))
        second=max(self.shelves[v],key=lambda x:(self.sim[self.index[x],best],x))
        genres=sorted(set(b['genres']) & (set(self.books[first]['genres'])|set(self.books[second]['genres'])))
        favorites=list(dict.fromkeys((self.books[first]['title'],self.books[second]['title'])))
        why=f"A new shared read to explore alongside {' and '.join(favorites)}."
        if genres: why+=f" Its catalog themes include {', '.join(genres[:2])}, which also appear on your shelves."
        return {'id':bid,'title':b['title'],'author':b['author'],'reason':why[:600],
                'a_affinity':round(float(aa[best]),6),'b_affinity':round(float(bb[best]),6),
                'source_url':b['metadata']['source_url'],'related_favorites':[first,second],'genres':genres}

    def explain(self,e):
        a,b=self.people[e['a']],self.people[e['b']]
        shared=e['book_evidence']['exact_overlap']
        if shared:
            sentence='You both list '+self.books[shared[0]]['title']+' among your favorite books.'
        elif e['book_evidence'].get('author_overlap'):
            author=e['book_evidence']['author_overlap'][0]
            name=next(self.books[bid]['author'] for bid in self.shelves[e['a']] if key(self.books[bid]['author'])==author)
            sentence='You both list books by '+name+' among your favorites.'
        elif e.get('quality_tier')=='weak_first_introduction':
            sentence='This is an exploratory '+{'friends':'friendship','romance':'romantic','business_partners':'business'}[e['type']]+' introduction. Your listed favorites offer limited verified evidence of shared reading tastes.'
        else:
            x,y=e['book_evidence']['strongest_book_pair'];genres=sorted(set(self.books[x]['genres'])&set(self.books[y]['genres']))
            if genres: sentence=f"Your shelves both include {', '.join(genres[:2])}, with {self.books[x]['title']} and {self.books[y]['title']} offering a starting point for conversation."
            else: sentence=f"Your favorites {self.books[x]['title']} and {self.books[y]['title']} offer a starting point for comparing your reading tastes."
        if e.get('quality_tier')=='weak_first_introduction' and (shared or e['book_evidence'].get('author_overlap')):
            sentence='This is an exploratory introduction. '+sentence
        if a['city_id']==b['city_id']: sentence+=' You are both in '+a['city']+'.'
        elif e['distance_km']>250 and all(p['location_preference']=='anywhere' for p in (a,b)): sentence+=' This is a long-distance introduction; you both selected openness to connecting anywhere.'
        else: sentence+=f" You are in {a['city']} and {b['city']}."
        if e['shared_activities']: sentence+=' You both mentioned '+', '.join(e['shared_activities'][:2])+'.'
        return sentence[:1000]

    def run(self,variant='embeddings',output='plan.json'):
        started=time.monotonic();edges,counts=self.candidates(variant)
        edge_path=self.directory/(variant+'-candidates.jsonl')
        with edge_path.open('w') as f:
            for e in edges:f.write(json.dumps(e,sort_keys=True)+'\n')
        allocation_proof=None;allocation_repair=None;allocation_timing={};matches=[]
        if self.policy.get('allocation_method')=='edge_cover':
            from edge_cover import allocate_edge_cover
            selected,result=allocate_edge_cover(edges,self.hard_eligible_users,weighted_matching=self.policy.get('weighted_edge_cover_matching',True))
            allocation_timing={k:result.pop(k) for k in ('matching_seconds','elapsed_seconds') if k in result}
            stages=[];allocation_proof={'sparsification':self.sparsification,'allocation':result,
                'hard_eligible_user_ids':self.hard_eligible_users,
                'isolated_active_user_ids':sorted({p['user_id'] for p in self.active}-set(self.hard_eligible_users))}
            print(json.dumps({'coverage_allocation':{k:v for k,v in result.items() if k!='heavy_helpers_over_three'},'timing':allocation_timing}),flush=True)
        else:
            selected,stages=optimize(edges,{**self.policy,'_checkpoint_dir':str(self.directory/'solver-checkpoints')})
            before_repair=selected_objectives(edges,selected,self.policy);repairs=[]
            covered_before_repair=sorted({u for i in selected for u in (edges[i]['a'],edges[i]['b'])})
            if self.policy.get('repair_final_coverage'):selected,repairs=repair_coverage(edges,selected,self.policy)
            allocation_repair={'enabled':bool(self.policy.get('repair_final_coverage')),'objective_order':objective_names(self.policy),
                               'before':before_repair,'after':selected_objectives(edges,selected,self.policy),'moves':repairs,
                               'covered_user_ids_before':covered_before_repair,
                               'note':'Solver stages describe the allocation before this deterministic coverage repair. The first coverage upper bound remains valid; later bounds are conditional on the pre-repair objectives. Every move adds unique coverage and preserves all previously covered people.'}
            if repairs:print(json.dumps({'coverage_repair_moves':len(repairs),'before':before_repair,'after':allocation_repair['after']}),flush=True)
        validate_requested_edges([edges[i] for i in selected],self.policy,'selected allocation')
        assigned=set()
        for i in selected:
            e=edges[i];identifier=str(uuid.uuid5(uuid.NAMESPACE_URL,'zbc:round2:'+self.policy['as_of_date']+':'+e['type']+':'+pair_key(e['a'],e['b'])))
            flags=constraint_flags(self.people[e['a']],self.people[e['b']],e['type'])
            decision=self.policy.get('manual_pair_decisions',{}).get(e['type']+'|'+pair_key(e['a'],e['b']))
            if decision and decision.get('decision')=='clear': flags=[]
            rec=self.recommend(e)
            if rec:
                for u in (e['a'],e['b']):self.read_books[u].add(rec['id'])
            m={**e,'id':identifier,'member_reason':self.explain(e),'recommended_book':rec,'written_boundary_flags':flags,
               'status':'needs_contact_review' if e.get('contact_review_user_ids') else 'needs_boundary_review' if flags else 'needs_book_review' if rec is None else 'proposed',
               'review_decision':decision,'release_authorized':False,
               'email_only_user_ids':[u for u in (e['a'],e['b']) if u in self.policy.get('email_only_user_ids',[])]}
            matches.append(m)
            for u in (e['a'],e['b']): assigned.add((u,e['type']))
        unmatched=[]
        for p in self.snapshot['profiles']:
            u=p['user_id']
            for kind in p['intents']:
                if (u,kind) in assigned:continue
                count=self.candidates_per_person[(u,kind)]
                unmatched.append({'user_id':u,'type':kind,'reason':self.excluded.get(u) or ('capacity_competition' if count else 'no_candidate_above_threshold' if self.structural_candidates[(u,kind)] else 'no_mutually_eligible_candidate'),
                                  'structural_candidate_count':self.structural_candidates[(u,kind)],
                                  'candidate_count':count,'gates':dict(self.gates[(u,kind)]),'top_alternatives':self.top_alternatives.get((u,kind),[])})
        core={'schema_version':1,'variant':variant,'snapshot_sha256':digest(self.snapshot),'policy_sha256':digest(self.policy),
              'book_metadata_sha256':digest(self.books),'model_manifest_sha256':digest(self.model),
              'model_revision':self.model['revision'],'book_vectors_sha256':self.model['vectors_sha256'],
              'matches':sorted(matches,key=lambda m:(KINDS.index(m['type']),m['a'],m['b'])),
              'unmatched':sorted(unmatched,key=lambda x:(x['user_id'],x['type'])),'identity_decisions':self.identity_decisions,'excluded':self.excluded,
              'release_authorized':False}
        if allocation_proof:core.update(allocation_method='edge_cover',allocation_proof=allocation_proof)
        else:core['allocation_repair']=allocation_repair
        source=Path(__file__).parent
        core['source_hashes']={name:hashlib.sha256((source/name).read_bytes()).hexdigest()
                               for name in ('engine.py','edge_cover.py','prepare.py','audit.py','metros.py','refresh_sparse_metadata.py','requirements.lock.txt','recommendation_catalog.json','book_identity_overrides.json')}
        core['plan_sha256']=digest(core)
        core['summary']={'candidate_edges':len(edges),'pairs':len(matches),'people':len({u for m in matches for u in (m['a'],m['b'])}),
                         'by_type':dict(collections.Counter(m['type'] for m in matches)),
                         'statuses':dict(collections.Counter(m['status'] for m in matches)),
                         'active_profiles':len(self.active),'gate_totals':counts,'solver_stages':stages,
                         'allocation_timing':allocation_timing,
                         'elapsed_seconds':round(time.monotonic()-started,3)}
        write(self.directory/output,core);print(json.dumps(core['summary']),flush=True)
        return core

def main():
    ap=argparse.ArgumentParser();ap.add_argument('run_dir',type=Path);ap.add_argument('--variant',choices=['embeddings','baseline'],default='embeddings');ap.add_argument('--output',default='plan.json')
    args=ap.parse_args();Matcher(args.run_dir).run(args.variant,args.output)
if __name__=='__main__':main()
