import copy, unittest,collections,hashlib,json,tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
from engine import eligible, exclusions, optimize, optimize_component, pair_key, score_components, threshold_for, history_data,tags,validate_review_decisions,Matcher,constraint_flags,allocation_valid,augment_coverage_hint,reading_rescue_basis,repair_coverage,books_age_components,validate_requested_pairs,validate_requested_eligibility,validate_requested_edges,requested_edge_fields
from prepare import collect, enrich,digest
from metros import in_ring,winding
from refresh_sparse_metadata import exact_candidate

def person(uid,**changes):
    return dict({'user_id':uid,'name':uid,'age':27,'intents':['romance','friends'],'gender':'woman',
                 'interested_in':['woman','man','other'],'age_min':24,'age_max':35,'city_id':1,
                 'country':'Example','location_preference':'anywhere','is_active':True,'has_contact':True,
                 'favorites':[{'id':'OL1W','title':'Book A','author':'Author A'}],
                 'instagram_handle':None,'created_at':'2020-01-01'},**changes)

POLICY={'friendship_age_gap_under_25':5,'friendship_age_gap_other':8,'blocked_country_pairs':[],
        'max_per_type':1,'max_total':3,'seed':17,'max_deterministic_time':10,
        'candidate_thresholds':{'romance':.56,'friends':.55,'business_partners':.55}}

class EligibilityTests(unittest.TestCase):
    def test_member_radii_are_reciprocal_and_cannot_be_overridden_by_coverage(self):
        a=person('a',latitude=0.,longitude=0.,location_preference='radius',match_radius_miles=70)
        b=person('b',city_id=2,latitude=0.,longitude=1.) # about 69.09 miles
        for policy in (POLICY,{**POLICY,'ignore_location':True,'allow_weak_first_introduction':True}):
            for kind in ('friends','romance'):
                self.assertIsNone(eligible(a,b,kind,policy,set(),set()))
                for x,y in ((a,b),(b,a)):
                    limited={**a,'match_radius_miles':69}
                    self.assertEqual(eligible(limited if x is a else x,limited if y is a else y,kind,policy,set(),set()),'distance_radius_preference')
                self.assertEqual(eligible(a,{**b,'location_preference':'radius','match_radius_miles':10},kind,policy,set(),set()),'distance_radius_preference')
        self.assertIsNone(eligible({**a,'location_preference':'anywhere'}, {**b,'longitude':179.},'friends',POLICY,set(),set()))

    def test_radius_requires_known_coordinates_and_valid_limits_and_crosses_date_line(self):
        a=person('a',latitude=0.,longitude=179.9,location_preference='radius',match_radius_miles=14)
        b=person('b',latitude=0.,longitude=-179.9)
        self.assertIsNone(eligible(a,b,'friends',POLICY,set(),set()))
        for radius in (None,0,-1,1.5,301,True,'50'):
            self.assertEqual(eligible({**a,'match_radius_miles':radius},b,'friends',POLICY,set(),set()),'invalid_distance_radius')
        for coordinate in (None,float('nan'),float('inf'),181.):
            self.assertEqual(eligible(a,{**b,'longitude':coordinate},'friends',POLICY,set(),set()),'unknown_distance')
        self.assertIsNone(eligible({**a,'match_radius_miles':1},{**b,'longitude':179.9},'friends',POLICY,set(),set()))
        self.assertIsNone(eligible({**a,'match_radius_miles':300},{**b,'longitude':0.},'friends',POLICY,set(),set()))
        self.assertEqual(eligible({**a,'match_radius_miles':300},{**b,'longitude':0.,'location_preference':'radius','match_radius_miles':299},'friends',POLICY,set(),set()),'distance_radius_preference')

    def test_explicit_location_override_preserves_romantic_preferences(self):
        a,b=person('a',location_preference='same_city'),person('b',city_id=2)
        policy={**POLICY,'ignore_location':True}
        self.assertIsNone(eligible(a,b,'romance',policy,set(),set()))
        b['age']=60
        self.assertEqual(eligible(a,b,'romance',policy,set(),set()),'reciprocal_age_preference')
        b['age']=27;b['interested_in']=['man']
        self.assertEqual(eligible(a,b,'romance',policy,set(),set()),'reciprocal_gender_preference')
        self.assertEqual(eligible(a,b,'friends',policy,{'a|b'},set()),'previous_introduction')
    def test_books_age_scoring_has_no_location_term(self):
        parts=books_age_components('romance',.5,None,10,{'age_gap_scale_years':10})
        self.assertEqual(parts,{'book':.45,'age':.05})
        self.assertNotIn('location',parts)
    def test_negated_activity_is_not_shared_interest(self):
        self.assertNotIn('hiking',tags("I don't enjoy hiking. I like coffee."))
        self.assertIn('coffee',tags("I don't enjoy hiking. I like coffee."))
        self.assertIn('coffee',tags('I like not only coffee but also music.'))
    def test_age_and_gender_are_reciprocal(self):
        a,b=person('a'),person('b',age=30,age_min=28)
        self.assertEqual(eligible(a,b,'romance',POLICY,set(),set()),'reciprocal_age_preference')
        b['age_min']=24;b['interested_in']=['man']
        self.assertEqual(eligible(a,b,'romance',POLICY,set(),set()),'reciprocal_gender_preference')
        self.assertEqual(eligible(b,a,'romance',POLICY,set(),set()),'reciprocal_gender_preference')
    def test_friendship_requires_both_selections(self):
        self.assertEqual(eligible(person('a',intents=['romance']),person('b'),'friends',POLICY,set(),set()),'type_not_selected_by_both')
    def test_city_limit_requires_verified_metro(self):
        a,b=person('a',location_preference='same_city'),person('b',city_id=2)
        self.assertEqual(eligible(a,b,'romance',POLICY,set(),set()),'city_or_metro_preference')
        p={**POLICY,'verified_metro_city_pairs':[[1,2]]}
        self.assertIsNone(eligible(a,b,'romance',p,set(),set()))
    def test_prior_pair_cannot_return_as_another_type(self):
        self.assertEqual(eligible(person('a'),person('b'),'friends',POLICY,{'a|b'},set()),'previous_introduction')
    def test_block_is_bidirectional(self):
        self.assertEqual(eligible(person('b'),person('a'),'friends',POLICY,set(),{pair_key('a','b')}),'blocked')
    def test_review_accounts_paused_and_no_contact_excluded(self):
        s={'profiles':[person('a'),person('b',is_active=False),person('c',has_contact=False)],
           'review_accounts':[{'user_id':'a'}],'pending_reports':[]}
        excluded,_=exclusions(s,POLICY)
        self.assertEqual(set(excluded),{'a','b','c'})
    def test_duplicate_contact_uses_newer_active_account(self):
        s={'profiles':[person('a',instagram_handle='reader'),person('b',instagram_handle='READER',created_at='2021-01-01')],
           'review_accounts':[],'pending_reports':[]}
        excluded,decisions=exclusions(s,POLICY)
        self.assertEqual(set(excluded),{'a'});self.assertEqual(decisions[0]['retained'],'b')
    def test_history_preserves_unreleased_pairs_but_not_romance_priority(self):
        s={'matches':[{'id':'m','intent':'romance','released_at':None,'members':[{'user_id':'a'},{'user_id':'b'}]}]}
        pairs,romance,_=history_data(s);self.assertIn('a|b',pairs);self.assertFalse(romance)
    def test_review_decision_cannot_survive_changed_profile(self):
        people={u:person(u) for u in ('a','b')}
        decision={'decision':'clear','rationale':'The flagged word refers to a book topic.',
                  'profile_sha256':{u:digest(p) for u,p in people.items()}}
        policy={**POLICY,'manual_pair_decisions':{'romance|a|b':decision}}
        validate_review_decisions(people,policy)
        people['b']['romance_ideal_match']='I do not want children.'
        with self.assertRaisesRegex(ValueError,'Stale'):validate_review_decisions(people,policy)
    def test_owner_hold_follows_duplicate_contact(self):
        s={'profiles':[person('a',instagram_handle='reader'),person('b',instagram_handle='READER')],
           'review_accounts':[],'pending_reports':[]}
        excluded,_=exclusions(s,{**POLICY,'held_user_ids':{'a':'Owner hold'}})
        self.assertEqual(set(excluded),{'a','b'})
    def test_email_only_override_requires_consented_email(self):
        s={'profiles':[person('a',instagram_handle='reader',has_signup_email=True,share_email_with_matches=False)],
           'review_accounts':[],'pending_reports':[]}
        excluded,_=exclusions(s,{**POLICY,'email_only_user_ids':['a']})
        self.assertIn('a',excluded)

class RequestedPairTests(unittest.TestCase):
    def policy(self,people,**changes):
        return {**POLICY,'release_authorized':False,'requested_pairs':[
            {'a':'a','b':'b','type':'romance','reason':'Explicit private operator request',
             'profile_sha256':{u:digest(people[u]) for u in ('a','b')},
             'contact_hold_user_ids':sorted(u for u in ('a','b') if not people[u]['has_contact'])}],**changes}

    def test_exact_profile_hashes_required(self):
        people={u:person(u) for u in ('a','b')};policy=self.policy(people)
        validate_requested_pairs(people,policy)
        people['b']['age']=28
        with self.assertRaisesRegex(ValueError,'Stale'):validate_requested_pairs(people,policy)

    def test_endpoints_must_be_unique_across_requests(self):
        people={u:person(u) for u in ('a','b','c')};policy=self.policy(people)
        policy['requested_pairs'].append({'a':'b','b':'c','type':'friends','reason':'Another request',
                                         'profile_sha256':{u:digest(people[u]) for u in ('b','c')},'contact_hold_user_ids':[]})
        with self.assertRaisesRegex(ValueError,'unique'):validate_requested_pairs(people,policy)

    def test_contact_exception_is_named_exact_and_private_only(self):
        people={'a':person('a'),'b':person('b',has_contact=False),'c':person('c',has_contact=False)}
        policy=self.policy(people);snapshot={'profiles':list(people.values())}
        excluded,_=exclusions(snapshot,policy);self.assertNotIn('b',excluded);self.assertIn('c',excluded)
        for holds in ([],['c'],['b','b'],['a','b']):
            with self.subTest(holds=holds):
                bad=copy.deepcopy(policy);bad['requested_pairs'][0]['contact_hold_user_ids']=holds
                with self.assertRaises(ValueError):exclusions(snapshot,bad)
        with self.assertRaisesRegex(ValueError,'private planning only'):
            exclusions(snapshot,{**policy,'release_authorized':True})

    def test_contact_exception_keeps_all_other_account_exclusions(self):
        for change in ({'is_active':False},{'age':17},{'favorites':[]}):
            with self.subTest(change=change):
                people={'a':person('a'),'b':person('b',has_contact=False,**change)}
                policy=self.policy(people);excluded,_=exclusions({'profiles':list(people.values())},policy)
                self.assertIn('b',excluded)
                with self.assertRaisesRegex(ValueError,'excluded member'):
                    validate_requested_eligibility(people,policy,excluded,set(),set())
        people={'a':person('a'),'b':person('b',has_contact=False)}
        for snapshot_extra,policy_extra in (({'review_accounts':[{'user_id':'b'}]},{}),
                                             ({'pending_reports':[{'reported_id':'b'}]},{}),
                                             ({},{'held_user_ids':{'b':'Owner hold'}}),
                                             ({},{'excluded_user_ids':{'b':'Operator exclusion'}}),
                                             ({},{'email_only_user_ids':['b']})):
            with self.subTest(snapshot_extra=snapshot_extra,policy_extra=policy_extra):
                excluded,_=exclusions({'profiles':list(people.values()),**snapshot_extra},self.policy(people,**policy_extra))
                self.assertIn('b',excluded)

    def test_both_endpoints_reserved_to_exact_type_and_partner(self):
        people={u:person(u) for u in ('a','b','c')};policy=self.policy(people)
        self.assertIsNone(eligible(people['a'],people['b'],'romance',policy,set(),set()))
        for a,b,kind in (('a','c','romance'),('c','b','friends'),('b','a','friends')):
            with self.subTest(a=a,b=b,kind=kind):
                self.assertEqual(eligible(people[a],people[b],kind,policy,set(),set()),'exclusive_owner_requested_pair')

    def test_request_does_not_override_preferences_history_blocks_or_manual_exclusion(self):
        for change,reason in (({'age':60},'reciprocal_age_preference'),
                               ({'interested_in':['man']},'reciprocal_gender_preference'),
                               ({'intents':['friends']},'type_not_selected_by_both')):
            people={'a':person('a'),'b':person('b',**change)}
            with self.subTest(reason=reason),self.assertRaisesRegex(ValueError,reason):
                validate_requested_eligibility(people,self.policy(people),{},set(),set())
        people={u:person(u) for u in ('a','b')};policy=self.policy(people)
        with self.assertRaisesRegex(ValueError,'previous_introduction'):
            validate_requested_eligibility(people,policy,{}, {'a|b'},set())
        with self.assertRaisesRegex(ValueError,'blocked'):
            validate_requested_eligibility(people,policy,{},set(),{'a|b'})
        policy['manual_pair_decisions']={'romance|a|b':{'decision':'exclude'}}
        with self.assertRaisesRegex(ValueError,'reviewed_written_boundary'):
            validate_requested_eligibility(people,policy,{},set(),set())

    def fixture(self,directory):
        profiles=[person('a'),person('b',has_contact=False,romance_ideal_match='Must share my faith.'),person('c'),person('d')]
        for p in profiles:p.update(latitude=0,longitude=0,city='Example City')
        people={p['user_id']:p for p in profiles}
        policy=self.policy(people,as_of_date='2026-01-01',minimum_book_support=.2,ignore_location=True,
                           allow_weak_first_introduction=True,allocation_method='edge_cover',weighted_edge_cover_matching=False)
        books={'OL1W':{'id':'OL1W','title':'Book A','author':'Author A','frequency':4,'metadata_adequate':True,
                        'genres':['fantasy'],'metadata':{'source_url':'https://openlibrary.org/works/OL1W.json'}}}
        np.save(directory/'book-vectors.npy',np.array([[1.,0.]],dtype=np.float32))
        values={'snapshot.json':{'profiles':profiles,'matches':[],'library':[]},'policy.json':policy,
                'books.json':books,'aliases.json':{'OL1W':'OL1W'},
                'model.json':{'ids':['OL1W'],'revision':'unit-test','books_sha256':digest(books),
                              'vectors_sha256':hashlib.sha256((directory/'book-vectors.npy').read_bytes()).hexdigest()}}
        for name,value in values.items():(directory/name).write_text(json.dumps(value))
        return Matcher(directory)

    def test_requested_contact_pair_survives_real_sparsification_and_allocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            matcher=self.fixture(Path(temporary));edges,_=matcher.candidates()
            involving=[e for e in edges if {'a','b'}&{e['a'],e['b']}]
            self.assertEqual([(e['type'],e['a'],e['b']) for e in involving],[('romance','a','b')])
            plan=self.fixture(Path(temporary)).run()
            rows=[m for m in plan['matches'] if m['owner_requested_pair']]
            self.assertEqual(len(rows),1);match=rows[0]
            self.assertEqual(match['contact_review_user_ids'],['b'])
            self.assertEqual(match['status'],'needs_contact_review')
            self.assertTrue(match['written_boundary_flags']);self.assertIsNone(match['recommended_book'])
            self.assertFalse(match['release_authorized']);self.assertFalse(plan['release_authorized'])
            counts=collections.Counter(u for m in plan['matches'] for u in (m['a'],m['b']))
            self.assertEqual((counts['a'],counts['b']),(1,1))

    def test_requested_pair_cannot_silently_disappear_from_retained_graph(self):
        with tempfile.TemporaryDirectory() as temporary:
            matcher=self.fixture(Path(temporary))
            with patch('edge_cover.SparseCollector.finish',return_value=([],{})):
                with self.assertRaisesRegex(ValueError,'retained candidate graph'):matcher.candidates()

    def test_requested_pair_cannot_silently_disappear_from_selected_allocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            matcher=self.fixture(Path(temporary))
            with patch('edge_cover.allocate_edge_cover',return_value=([],{'passed':True})):
                with self.assertRaisesRegex(ValueError,'selected allocation'):matcher.run()

    def test_injected_extra_partner_or_contact_disclosure_is_rejected(self):
        people={u:person(u) for u in ('a','b','c')};policy=self.policy(people)
        wanted={'a':'a','b':'b','type':'romance',**requested_edge_fields('a','b','romance',policy)}
        extra={'a':'a','b':'c','type':'friends',**requested_edge_fields('a','c','friends',policy)}
        with self.assertRaisesRegex(ValueError,'exclusivity'):
            validate_requested_edges([wanted,extra],policy,'selected allocation')
        with self.assertRaisesRegex(ValueError,'disclosure'):
            validate_requested_edges([{**wanted,'contact_review_user_ids':['c']}],policy,'selected allocation')

class AllocationTests(unittest.TestCase):
    def edge(self,a,b,score,kind='romance',priority=0):
        return {'a':a,'b':b,'score_integer':score,'type':kind,'priority_people':priority}
    def test_global_allocation_avoids_greedy_trap(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90),self.edge('b','d',90)]
        selected,stages=optimize(edges,POLICY)
        self.assertEqual(selected,[1,2]);self.assertTrue(all(s['status']=='OPTIMAL' for s in stages))
    def test_priority_then_coverage_then_quality(self):
        edges=[self.edge('a','b',100,priority=0),self.edge('a','c',60,priority=1)]
        selected,_=optimize(edges,POLICY);self.assertEqual(selected,[1])
    def test_same_pair_not_reused_across_types(self):
        edges=[self.edge('a','b',100),self.edge('a','b',90,'friends'),self.edge('a','c',70,'friends')]
        selected,_=optimize(edges,POLICY);self.assertEqual(selected,[0,2])
    def test_repeated_allocation_identical(self):
        edges=[self.edge('a','b',50),self.edge('a','c',50),self.edge('b','d',50),self.edge('c','d',50)]
        self.assertEqual(optimize(edges,POLICY)[0],optimize(edges,POLICY)[0])
    def test_distance_requires_more_evidence(self):
        self.assertGreater(threshold_for('romance',2000,POLICY),threshold_for('romance',0,POLICY))
    def test_first_introductions_precede_romance_priority(self):
        edges=[self.edge('a','b',100,priority=2),self.edge('a','c',90),self.edge('b','d',90)]
        selected,stages=optimize(edges,{**POLICY,'coverage_first':True})
        self.assertEqual(selected,[1,2]);self.assertEqual(stages[0]['objective'],4)
    def test_first_introductions_are_counted_across_types(self):
        edges=[self.edge('a','b',100),self.edge('a','c',70),self.edge('b','d',90,'friends')]
        selected,stages=optimize(edges,{**POLICY,'coverage_first':True})
        self.assertEqual(selected,[1,2]);self.assertEqual(stages[0]['objective'],4)
    def test_unflagged_introduction_precedes_conditional_pair(self):
        edges=[{**self.edge('a','b',100,priority=2),'boundary_review_required':True},self.edge('a','c',70)]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True})
        self.assertEqual(selected,[1])
    def test_explicit_everyone_priority_maximizes_unique_people_first(self):
        edges=[self.edge('a','b',100),
               {**self.edge('a','c',90),'boundary_review_required':True},
               {**self.edge('b','d',90),'boundary_review_required':True}]
        selected,stages=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True})
        self.assertEqual(selected,[1,2]);self.assertEqual(stages[0]['stage'],'members_with_any_proposal')
        self.assertEqual(stages[0]['objective'],4)
    def test_wider_friendship_cannot_be_an_extra_for_both_people(self):
        edges=[{**self.edge('a','b',100,'friends'),'friendship_age_gap_exception':True},
               self.edge('a','c',90),self.edge('b','d',80)]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True})
        self.assertEqual(selected,[1,2])
    def test_wider_friendship_can_supply_someones_only_introduction(self):
        edges=[{**self.edge('a','b',100,'friends'),'friendship_age_gap_exception':True},self.edge('a','c',90)]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True})
        self.assertEqual(selected,[0,1])
    def test_exhausted_solver_keeps_valid_frozen_warm_start(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90,'friends')]
        selected,stages=optimize_component(edges,{**POLICY,'coverage_first':True,'max_deterministic_time':0,
                                                   'warm_start_pairs':['romance|a|b','friends|a|c']})
        self.assertEqual(selected,[0,1])
        self.assertTrue(all(s['retained_previous_solution'] and s['status']=='FEASIBLE' for s in stages))
        self.assertEqual(stages[0]['objective'],3)
    def test_invalid_warm_start_cannot_bypass_constraints(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90)]
        with self.assertRaisesRegex(ValueError,'Warm start'):
            optimize_component(edges,{**POLICY,'warm_start_pairs':['romance|a|b','romance|a|c']})
    def test_second_intro_helps_two_other_people_get_their_only_match(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90)]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True,
                                   'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(selected,[0,1])
    def test_second_intros_cannot_form_a_cycle_of_extras(self):
        edges=[self.edge('a','b',100),self.edge('b','c',90),self.edge('a','c',80)]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True,
                                   'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(len(selected),2)
    def test_second_intro_does_not_restrict_the_existing_first_recipient(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90),self.edge('b','d',80,'friends')]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True,
                                   'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(selected,[0,1,2])
    def test_second_intro_needs_a_sole_recipient(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90),self.edge('b','d',80,'friends'),self.edge('c','e',70,'friends')]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True,
                                   'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(selected,[0,2,3])
    def test_reading_rescue_must_serve_originally_unmatched_endpoint(self):
        edges=[{**self.edge('a','b',100),'first_introduction_rescue':True,'rescue_target_user_ids':['a']},
               self.edge('a','c',90,'friends')]
        selected,_=optimize(edges,{**POLICY,'coverage_first':True,'prioritize_any_introduction':True})
        self.assertEqual(selected,[0])
    def test_augmentation_preserves_existing_sole_recipient_conditions(self):
        edges=[self.edge('a','b',100),self.edge('a','c',90),self.edge('b','d',80,'friends'),self.edge('c','e',70,'friends')]
        policy={**POLICY,'max_per_type':2,'second_intro_only_for_first_match':True}
        chosen=augment_coverage_hint(edges,[0,1],policy)
        self.assertTrue(allocation_valid(edges,chosen,policy))
        self.assertEqual(len(chosen),3)
        self.assertFalse(allocation_valid(edges,[0,1,2,3],policy))
    def test_second_romance_does_not_double_count_prior_round_priority(self):
        edges=[{**self.edge('a','b',100,priority=1),'priority_user_ids':['a']},
               {**self.edge('a','c',90,priority=1),'priority_user_ids':['a']}]
        selected,stages=optimize(edges,{**POLICY,'coverage_first':True,'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(selected,[0,1])
        self.assertEqual(next(s['objective'] for s in stages if s['stage']=='previously_without_romance'),1)
    def test_coverage_repair_preserves_every_existing_recipient(self):
        edges=[self.edge('a','b',100),self.edge('b','c',90),self.edge('c','e',85),self.edge('a','d',80)]
        policy={**POLICY,'max_per_type':2,'second_intro_only_for_first_match':True}
        selected,moves=repair_coverage(edges,[0,1,2],policy)
        self.assertEqual(selected,[1,2,3]);self.assertEqual(len(moves),1)
        self.assertEqual({u for i in selected for u in (edges[i]['a'],edges[i]['b'])},{'a','b','c','d','e'})
        self.assertTrue(allocation_valid(edges,selected,policy))
        self.assertEqual(repair_coverage(edges,selected,policy),(selected,[]))
    def test_coverage_repair_does_not_bypass_wider_age_condition(self):
        edges=[{**self.edge('a','b',100,'friends'),'friendship_age_gap_exception':True},
               self.edge('a','c',90),self.edge('b','d',80)]
        selected,_=repair_coverage(edges,[0,1],{**POLICY,'max_per_type':2,'second_intro_only_for_first_match':True})
        self.assertEqual(selected,[1,2])

class ReadingRescueTests(unittest.TestCase):
    def test_requires_factual_reading_basis_and_first_match_target(self):
        rule={'first_introduction_reading_rule':{'minimum_book_fit':.30,'minimum_score':.30,'shelf_fit_with_shared_genre':.45}}
        book={'exact_overlap':[],'author_overlap':[]}
        self.assertEqual(reading_rescue_basis('romance',.50,.35,book,[],['a'],rule),[])
        self.assertEqual(reading_rescue_basis('romance',.44,.35,book,['fantasy'],['a'],rule),[])
        self.assertEqual(reading_rescue_basis('romance',.50,.35,book,['fantasy'],[],rule),[])
        self.assertEqual(reading_rescue_basis('business_partners',.50,.35,book,['fantasy'],['a'],rule),[])
        self.assertEqual(reading_rescue_basis('friends',.50,.35,book,['fantasy'],['a'],rule),['shelf_fit_and_shared_catalog_genre'])
        self.assertEqual(reading_rescue_basis('romance',.35,.35,{**book,'exact_overlap':['book']},[],['a'],rule),['shared_favorite_book'])
        self.assertEqual(reading_rescue_basis('romance',.29,.35,{**book,'exact_overlap':['book']},[],['a'],rule),[])
        self.assertEqual(reading_rescue_basis('romance',.35,.29,{**book,'exact_overlap':['book']},[],['a'],rule),[])

class MetadataTests(unittest.TestCase):
    def test_vectorized_reading_scores_equal_detailed_scores(self):
        m=Matcher.__new__(Matcher);m.ids=list('abcdef');m.index={b:i for i,b in enumerate(m.ids)}
        m.books={b:{'frequency':i+1} for i,b in enumerate(m.ids)}
        m.shelves={'u':['a','b'],'v':['b','c','d'],'w':['e'],'x':['a','f']}
        m.authors={'u':{'one','two'},'v':{'two','three'},'w':set(),'x':{'one'}}
        m.active=[{'user_id':u} for u in m.shelves]
        values=np.arange(36).reshape(6,6)/50;m.sim=(values+values.T)/2;np.fill_diagonal(m.sim,1);m.semantic=m.sim.copy()
        ix,fits=m.reading_fit_matrix()
        for a in m.shelves:
            for b in m.shelves:self.assertAlmostEqual(fits[ix[a],ix[b]],m.book_fit(a,b)[0],places=6)
    def test_sparse_refinement_does_not_substitute_another_author(self):
        book={'title':'The Trial','author':'Franz Kafka'}
        self.assertTrue(exact_candidate(book,{'title':'Trial','author_name':['Franz Kafka']}))
        self.assertFalse(exact_candidate(book,{'title':'The Trial','author_name':['Another Author']}))
        self.assertFalse(exact_candidate({'title':'Trial','author':'Unknown author'},{'title':'Trial','author_name':['Unknown author']}))
    def test_recommendations_require_curated_entry_and_avoid_either_read_history(self):
        matcher=Matcher.__new__(Matcher);matcher.ids=['sequel','entry','read'];matcher.index={x:i for i,x in enumerate(matcher.ids)}
        matcher.policy={'recommendation_allowlist':['entry','read']};matcher.read_books=collections.defaultdict(set,{'a':{'read'}})
        matcher.books={x:{'title':x,'author':'Author','metadata_adequate':True,'genres':['fantasy'],
                          'metadata':{'source_url':'https://openlibrary.org/works/OL1W.json'}} for x in matcher.ids}
        matcher.shelves={'a':['read'],'b':['read']};matcher.sim=np.ones((3,3))
        matcher.person_affinity={'a':np.array([1.,.8,.9]),'b':np.array([1.,.8,.9])}
        self.assertEqual(matcher.recommend({'a':'a','b':'b'})['id'],'entry')
        matcher.read_books['b'].add('entry');self.assertIsNone(matcher.recommend({'a':'a','b':'b'}))
        matcher.read_books['b'].clear()
        matcher.books['read']['metadata']['source_work_id']='OL1W'
        matcher.books['entry']['metadata']['source_work_id']='OL1W'
        self.assertIsNone(matcher.recommend({'a':'a','b':'b'}))
        matcher.books['entry']['metadata']['source_work_id']='OL2W'
        matcher.policy['series_entry_recommendation_ids']=['entry']
        self.assertIsNone(matcher.recommend({'a':'a','b':'b'}))
    def test_unrecorded_religion_and_parenting_preferences_are_flagged(self):
        a=person('a',romance_ideal_match='Someone also Jewish is really important to me.')
        b=person('b',romance_ideal_match='I hope to build a family someday.')
        self.assertEqual(len(constraint_flags(a,b,'romance')),2)
        self.assertFalse(constraint_flags(a,b,'friends'))
    def test_unrecorded_height_and_additional_faith_language_are_flagged(self):
        rows=constraint_flags(person('a',romance_ideal_match='Someone who loves Jesus.'),
                              person('b',romance_ideal_match='Someone taller than me.'),'romance')
        self.assertEqual(len(rows),2)
    def test_explicit_friendship_requirements_are_also_reviewed(self):
        a=person('a',friendship_interests='Must love dogs. Fanfiction fans, otherwise DNI.')
        self.assertTrue(constraint_flags(a,person('b'),'friends'))
        a['friendship_interests']='I am looking for primarily female friends.'
        self.assertFalse(constraint_flags(a,person('b',gender='woman'),'friends'))
        self.assertTrue(constraint_flags(a,person('b',gender='man'),'friends'))
    def test_same_title_different_author_not_merged(self):
        s={'books':[{'work_id':'OL1W','title':'Home','author':'Author A'},{'work_id':'ZB2','title':'Home','author':'Author B'}],
           'profiles':[{'is_active':True,'favorites':[{'id':'OL1W','title':'Home','author':'Author A'},{'id':'ZB2','title':'Home','author':'Author B'}],'currently_reading':None}],
           'matches':[],'library':[]}
        books,aliases=collect(s);self.assertEqual(len(books),2)
    def test_title_only_metadata_not_treated_as_semantic_evidence(self):
        b=enrich({'id':'ZB1','title':'Love','author':'A'},{'subjects':['Fiction','Accessible book'],'description':''})
        self.assertFalse(b['metadata_adequate'])
    def test_specific_fiction_genres_survive_noise_filter(self):
        b=enrich({'id':'OL1W','title':'Title','author':'A'},{'subjects':['Fiction','Fiction / Fantasy','Magic','Accessible book'],'description':''})
        self.assertTrue(b['metadata_adequate']);self.assertIn('fantasy',b['genres']);self.assertNotIn('Fiction',b['subjects'])
    def test_reviewed_article_duplicate_merges_but_different_author_does_not(self):
        s={'books':[{'work_id':'OL14875876W','title':'Remains of the Day','author':'Kazuo Ishiguro'},
                    {'work_id':'OL59048W','title':'The Remains of the Day','author':'Kazuo Ishiguro'},
                    {'work_id':'custom','title':'The Remains of the Day','author':'Someone Else'}],
           'profiles':[{'is_active':True,'currently_reading':None,'favorites':[{'id':'OL14875876W','title':'Remains of the Day','author':'Kazuo Ishiguro'},
                                                    {'id':'custom','title':'The Remains of the Day','author':'Someone Else'}]}],
           'matches':[],'library':[]}
        books,aliases=collect(s)
        self.assertEqual(aliases['OL14875876W'],'OL59048W');self.assertEqual(len(books),2)

class GeographyTests(unittest.TestCase):
    def test_independent_polygon_tests_agree_for_concavity_and_orientation(self):
        ring=[(0,0),(4,0),(4,1),(1,1),(1,4),(0,4)]
        for test in (in_ring,winding):
            for polygon in (ring,list(reversed(ring))):
                self.assertTrue(test(.5,3,polygon));self.assertTrue(test(3,.5,polygon))
                self.assertFalse(test(3,3,polygon));self.assertFalse(test(-1,1,polygon))

if __name__=='__main__':unittest.main()
