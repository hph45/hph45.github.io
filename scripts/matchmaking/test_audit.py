"""Negative controls for the independent audit, using small complete artifacts."""
import collections
import contextlib
import copy
import hashlib
import io
import itertools
import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np

from audit import audit, independent_hard_eligible, independent_hard_graph, independent_identities, independent_location_free_components, independent_requested_pairs, independent_star_statistics
from prepare import collect, digest


def person(user, number, kind='friends', **changes):
    return {'user_id': user, 'name': user, 'age': 27, 'intents': [kind], 'gender': 'woman',
            'interested_in': ['woman'], 'age_min': 18, 'age_max': 90, 'city_id': number,
            'city': user, 'country': user, 'latitude': 0., 'longitude': 0., 'location_preference': 'same_city',
            'is_active': True, 'has_contact': True, 'instagram_handle': None, 'created_at': '2020-01-01',
            'favorites': [{'id': f'OL{number}W', 'title': f'Book {number}', 'author': f'Author {number}'}],
            'currently_reading': None, 'friendship_interests': '', 'romance_ideal_match': '',
            'business_skills': '', 'business_seeking': '', **changes}


class Artifact:
    def __init__(self, directory, kind='friends'):
        self.directory = Path(directory)
        self.snapshot = {'profiles': [person(u, i + 1, kind) for i, u in enumerate('abc')],
                         'books': [{'work_id': f'OL{i}W', 'title': f'Book {i}', 'author': f'Author {i}'} for i in range(1, 4)],
                         'matches': [], 'blocks': [], 'library': [], 'review_accounts': [], 'pending_reports': []}
        self.catalog = json.loads(Path(__file__).with_name('recommendation_catalog.json').read_text())
        self.policy = {'excluded_user_ids': {}, 'held_user_ids': {}, 'blocked_country_pairs': [['a', 'b']],
                       'historical_pairs': [], 'ignore_location': True, 'allow_weak_first_introduction': True,
                       'max_total': 3, 'max_per_type': 3, 'second_intro_only_for_first_match': True,
                       'friendship_age_gap_under_25': 5, 'friendship_age_gap_other': 8,
                       'candidate_thresholds': {'romance': .4, 'friends': .4, 'business_partners': .55},
                       'standard_candidate_thresholds': {'romance': .56, 'friends': .55, 'business_partners': .55},
                       'minimum_book_support': .2, 'standard_minimum_book_support': .3, 'coverage_first': True,
                       'recommendation_allowlist': [], 'recommendation_catalog_sha256': digest(self.catalog)}
        raw, self.aliases = collect(self.snapshot)
        self.books = {bid: {**book, 'genres': [], 'metadata_adequate': True,
                           'metadata': {'source_url': 'https://example.invalid/' + bid, 'source_work_id': bid}}
                      for bid, book in raw.items()}
        self.vectors = np.eye(3, dtype=np.float32)
        self.model = {'ids': list(self.books), 'revision': 'test'}
        score = 0. if kind == 'business_partners' else .1
        components = {'book': 0., 'complementary_skills': 0.} if kind == 'business_partners' else {'book': 0., 'age': .1}
        self.edges = []
        for a, b in itertools.combinations('abc', 2):
            self.edges.append({'a': a, 'b': b, 'type': kind, 'score': score, 'score_integer': int(round(score * 10000)),
                               'threshold': 0, 'distance_km': 0., 'book_fit': 0.,
                               'book_evidence': {'exact_overlap': [], 'author_overlap': []},
                               'score_components': components.copy(), 'shared_activities': [], 'shared_genres': [],
                               'standard_threshold': self.policy['standard_candidate_thresholds'][kind],
                               'quality_tier': 'weak_first_introduction', 'evidence_route': 'coverage_first_weak_evidence',
                               'friendship_age_gap_exception': False, 'age_gap_years': 0,
                               'first_introduction_rescue': True, 'rescue_target_user_ids': [],
                               'rescue_basis': ['owner_authorized_weak_fit_first_introduction'],
                               'location_preference_exception_user_ids': [a, b], 'boundary_review_required': False,
                               'business_evidence': {'a_offers_b_seeks': [], 'b_offers_a_seeks': []} if kind == 'business_partners' else {},
                               'priority_people': 0, 'priority_user_ids': []})
        matches = [self.match(edge, i) for i, edge in enumerate(self.edges[:2])]
        signature = hashlib.sha256(''.join(f'{kind}|{a}|{b}\n' for a, b in itertools.combinations('abc', 2)).encode()).hexdigest()
        self.plan = {'variant': 'embeddings', 'model_revision': 'test', 'matches': matches,
                     'unmatched': [], 'excluded': {}, 'identity_decisions': [], 'source_hashes': {},
                     'allocation_method': 'edge_cover', 'allocation_proof': {
                         'hard_eligible_user_ids': list('abc'), 'isolated_active_user_ids': [],
                         'sparsification': {'input_edges': 3, 'retained_edges': 3, 'input_vertices': 3, 'retained_vertices': 3,
                                            'lost_nonisolated_vertices': 0, 'ordered_input_keys_sha256': signature, 'coverage_preserved_exactly': True},
                         'allocation': {'passed': True, 'failures': [], 'people': 3, 'pairs': 2, 'maximum_total': 2,
                                        'maximum_per_type': 2, 'total_degree_histogram': {'1': 2, '2': 1},
                                        'extra_per_type_introductions': 1, 'heavy_helpers_over_three': [],
                                        'everyone_in_input_with_at_least_one_edge_is_covered': True,
                                        'every_pair_has_a_sole_recipient': True, 'global_minimum_helper_load_proven': False,
                                        'matching_pairs': 1, 'matching_covered_people': 2, 'minimum_pair_count_on_retained_graph': 2,
                                        'maximum_achievable_people_with_input_edges': 3, 'unique_coverage_optimal_on_full_input_graph': True,
                                        'minimum_pair_count_on_full_input_graph_proven': True}}}

    @staticmethod
    def match(edge, number):
        return {**copy.deepcopy(edge), 'id': f'm{number}', 'member_reason': 'An introduction to compare reading tastes.',
                'written_boundary_flags': [], 'review_decision': None, 'recommended_book': None,
                'status': 'needs_book_review', 'release_authorized': False, 'email_only_user_ids': []}

    def run(self):
        np.save(self.directory / 'book-vectors.npy', self.vectors)
        self.model['books_sha256'] = digest(self.books)
        self.plan.update(snapshot_sha256=digest(self.snapshot), policy_sha256=digest(self.policy),
                         book_vectors_sha256=hashlib.sha256((self.directory / 'book-vectors.npy').read_bytes()).hexdigest())
        self.plan['summary'] = {'pairs': len(self.plan['matches']), 'people': len({u for m in self.plan['matches'] for u in (m['a'], m['b'])}),
                                'by_type': dict(collections.Counter(m['type'] for m in self.plan['matches'])),
                                'statuses': dict(collections.Counter(m['status'] for m in self.plan['matches'])), 'solver_stages': []}
        self.plan['plan_sha256'] = digest({k: v for k, v in self.plan.items() if k not in ('summary', 'plan_sha256')})
        for name, value in [('snapshot', self.snapshot), ('policy', self.policy), ('books', self.books), ('aliases', self.aliases), ('model', self.model), ('plan', self.plan)]:
            (self.directory / (name + '.json')).write_text(json.dumps(value))
        (self.directory / 'embeddings-candidates.jsonl').write_text(''.join(json.dumps(e) + '\n' for e in self.edges))
        with contextlib.redirect_stdout(io.StringIO()):
            return audit(self.directory)


class AuditTests(unittest.TestCase):
    def test_radius_is_independently_checked_even_when_location_is_ignored(self):
        a=person('a',1,location_preference='radius',match_radius_miles=70)
        b=person('b',2,longitude=1.,location_preference='anywhere')
        policy={'ignore_location':True,'friendship_age_gap_other':8}
        self.assertTrue(independent_hard_eligible(a,b,'friends',policy,set(),set()))
        for x,y in (({**a,'match_radius_miles':69},b),(b,{**a,'match_radius_miles':69}),
                    (a,{**b,'longitude':None}),(a,{**b,'location_preference':'radius','match_radius_miles':10})):
            self.assertFalse(independent_hard_eligible(x,y,'friends',policy,set(),set()))

    def test_audit_rejects_an_out_of_radius_pair_even_if_plan_claims_coverage(self):
        artifact=self.make()
        a,b=artifact.snapshot['profiles'][:2]
        a.update(location_preference='radius',match_radius_miles=1)
        b.update(longitude=1.)
        self.assertRejected(artifact,'distance_radius_preferences_respected')

    def make(self, kind='friends'):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Artifact(directory.name, kind)

    def assertRejected(self, artifact, label):
        result = artifact.run()
        self.assertFalse(result['automated_checks_passed'])
        self.assertIn(label, {error['check'] for error in result['errors']})

    def requested_artifact(self, contact_hold=True):
        artifact = self.make('romance')
        people = {p['user_id']: p for p in artifact.snapshot['profiles']}
        people['b']['has_contact'] = not contact_hold
        people['b'].update(share_email_with_matches=False, has_signup_email=True)
        artifact.policy['requested_pairs'] = [{'a': 'a', 'b': 'b', 'type': 'romance',
            'reason': 'Explicit private request.', 'profile_sha256': {u: digest(people[u]) for u in 'ab'},
            'contact_hold_user_ids': ['b'] if contact_hold else []}]
        edge = artifact.edges[0]
        edge.update(owner_requested_pair=True, contact_review_user_ids=['b'] if contact_hold else [])
        artifact.edges = [edge]
        match = artifact.match(edge, 0)
        match['status'] = 'needs_contact_review' if contact_hold else 'needs_book_review'
        artifact.plan['matches'] = [match]
        artifact.plan['unmatched'] = [{'user_id': 'c', 'type': 'romance'}]
        proof = artifact.plan['allocation_proof']
        proof['hard_eligible_user_ids'] = ['a', 'b']
        proof['isolated_active_user_ids'] = ['c']
        proof['sparsification'].update(input_edges=1, retained_edges=1, input_vertices=2, retained_vertices=2,
            ordered_input_keys_sha256=hashlib.sha256(b'romance|a|b\n').hexdigest())
        proof['allocation'].update(people=2, pairs=1, maximum_total=1, maximum_per_type=1,
            total_degree_histogram={'1': 2}, extra_per_type_introductions=0,
            minimum_pair_count_on_retained_graph=1, maximum_achievable_people_with_input_edges=2)
        return artifact

    def test_valid_star_passes_for_all_selected_types_including_zero_business_reciprocity(self):
        for kind in ('friends', 'romance', 'business_partners'):
            with self.subTest(kind=kind):
                result = self.make(kind).run()
                self.assertTrue(result['automated_checks_passed'], result['errors'])

    def test_forged_coverage_proof_cannot_hide_eligible_person(self):
        artifact = self.make()
        artifact.plan['matches'].pop()
        artifact.plan['unmatched'] = [{'user_id': 'c', 'type': 'friends'}]
        artifact.plan['allocation_proof']['hard_eligible_user_ids'] = ['a', 'b']
        self.assertRejected(artifact, 'all_nonisolated_active_members_covered')

    def test_cycle_of_extras_is_rejected_even_with_everyone_covered(self):
        artifact = self.make()
        artifact.plan['matches'].append(artifact.match(artifact.edges[2], 2))
        self.assertRejected(artifact, 'every_selected_edge_has_a_sole_recipient')

    def test_location_score_cannot_hide_behind_matching_total(self):
        artifact = self.make()
        artifact.plan['matches'][0]['score_components'] = {'book': 0., 'location': .1}
        self.assertRejected(artifact, 'location_free_score_components_independently_recomputed')

    def test_local_preference_exception_must_name_each_affected_member(self):
        artifact = self.make()
        artifact.plan['matches'][0]['location_preference_exception_user_ids'] = ['a']
        self.assertRejected(artifact, 'location_preference_exceptions_disclosed')

    def test_weak_fit_cannot_be_presented_as_standard(self):
        artifact = self.make()
        artifact.plan['matches'][0]['quality_tier'] = 'standard'
        self.assertRejected(artifact, 'quality_tier_truthful')

    def test_previous_pair_survives_deleted_account_identity(self):
        artifact = self.make()
        artifact.policy.update(historical_identity_map={'deleted-a': 'a'}, historical_pairs=[['deleted-a', 'b']])
        self.assertRejected(artifact, 'no_previous_pair')

    def test_historical_recommendation_follows_deleted_account_to_current_identity(self):
        artifact = self.make()
        title = artifact.catalog['books'][0]
        bid = 'OL4W'
        artifact.snapshot['books'].append({'work_id': bid, 'title': title['title'], 'author': title['author']})
        artifact.books[bid] = {'id': bid, 'title': title['title'], 'author': title['author'], 'frequency': 0, 'source_ids': [],
                               'genres': [], 'metadata_adequate': True,
                               'metadata': {'source_work_id': bid, 'source_url': 'https://example.invalid/' + bid}}
        artifact.model['ids'].append(bid)
        artifact.vectors = np.vstack([artifact.vectors, np.full((1, 3), 1 / math.sqrt(3), dtype=np.float32)])
        artifact.policy.update(recommendation_allowlist=[bid], historical_identity_map={'deleted-a': 'a'},
                               historical_recommendations_by_user={'deleted-a': [bid]})
        affinity = round((float(artifact.vectors[3, 0]) - .15) / .65, 6)
        artifact.plan['matches'][0]['recommended_book'] = {'id': bid, 'title': title['title'], 'author': title['author'],
            'reason': 'A supported shared read.', 'a_affinity': affinity, 'b_affinity': affinity,
            'source_url': 'https://example.invalid/' + bid}
        artifact.plan['matches'][0]['status'] = 'proposed'
        self.assertRejected(artifact, 'recommendation_new_to_both')

    def test_legacy_scoring_and_non_edge_cover_plan_still_pass(self):
        artifact = self.make()
        artifact.policy.update(ignore_location=False, allow_weak_first_introduction=False, blocked_country_pairs=[],
                               minimum_book_support=0, standard_minimum_book_support=0)
        artifact.policy['candidate_thresholds']['friends'] = 0
        artifact.policy['standard_candidate_thresholds']['friends'] = 0
        for p in artifact.snapshot['profiles']:
            p['city_id'] = 1
        for m in artifact.plan['matches']:
            m.update(score=.25, score_integer=2500, score_components={'book': 0., 'location': .25},
                     quality_tier='standard', evidence_route='reading', first_introduction_rescue=False,
                     rescue_basis=[], standard_threshold=0, location_preference_exception_user_ids=[])
        artifact.plan.pop('allocation_method')
        artifact.plan.pop('allocation_proof')
        result = artifact.run()
        self.assertTrue(result['automated_checks_passed'], result['errors'])

    def test_independent_graph_keeps_geography_free_but_respects_history_blocks_and_age(self):
        people = {u: person(u, i + 1, 'romance') for i, u in enumerate('abcd')}
        people['d']['age'] = 17
        policy = self.make().policy
        graph = independent_hard_graph(people, set(people), policy, {frozenset('ab')}, {frozenset('ac')})
        self.assertEqual(graph['hard_eligible_user_ids'], ['b', 'c'])
        self.assertEqual(graph['isolated_active_user_ids'], ['a', 'd'])

    def test_independent_identity_selection_applies_holds_and_latest_duplicate(self):
        snapshot = {'profiles': [person('a', 1, instagram_handle='Reader'), person('b', 2, instagram_handle='reader', created_at='2021-01-01'),
                                 person('held', 3, instagram_handle='hold'), person('new-held', 4, instagram_handle='HOLD')],
                    'review_accounts': [], 'pending_reports': []}
        excluded, decisions = independent_identities(snapshot, {'held_user_ids': {'held': 'Owner hold'}})
        self.assertEqual(excluded, {'a', 'held', 'new-held'})
        self.assertEqual(decisions, {'a': 'b'})

    def test_age_component_is_reciprocal_and_does_not_use_location(self):
        self.assertEqual(independent_location_free_components('romance', .5, 10, {}), {'book': .45, 'age': .05})
        self.assertEqual(independent_location_free_components('business_partners', .5, 99, {}, business=0),
                         {'book': .25, 'complementary_skills': 0.})
        with self.assertRaises(ValueError):
            independent_location_free_components('friends', .5, 10, {'age_gap_scale_years': 0})

    def test_star_statistics_reject_long_path(self):
        self.assertFalse(independent_star_statistics([{'a': 'a', 'b': 'b'}, {'a': 'b', 'b': 'c'}, {'a': 'c', 'b': 'd'}])['every_edge_has_sole_endpoint'])

    def test_requested_pair_passes_with_contact_hold_or_existing_contact(self):
        for hold in (True, False):
            with self.subTest(contact_hold=hold):
                result = self.requested_artifact(hold).run()
                self.assertTrue(result['automated_checks_passed'], result['errors'])
                self.assertEqual(result['coverage_validation']['hard_eligible_people'], 2)
                self.assertEqual(result['coverage_validation']['isolated_active_user_ids'], ['c'])

    def test_requested_contact_exception_requires_current_profile_evidence(self):
        artifact = self.requested_artifact()
        artifact.snapshot['profiles'][1]['age_max'] = 50
        self.assertRejected(artifact, 'requested_pair_profile_evidence_current')
        excluded, _ = independent_identities(artifact.snapshot, artifact.policy)
        self.assertIn('b', excluded)

    def test_requested_contact_hold_cannot_name_unrelated_or_contactable_members(self):
        for ids in ([], ['a', 'b'], ['b', 'c'], ['b', 'b']):
            with self.subTest(ids=ids):
                artifact = self.requested_artifact()
                artifact.policy['requested_pairs'][0]['contact_hold_user_ids'] = ids
                self.assertRejected(artifact, 'requested_contact_hold_exactly_missing_contact')

    def test_requested_contact_exception_never_bypasses_account_exclusions(self):
        for condition in ('paused', 'minor', 'no_favorites', 'review_account', 'report', 'owner_hold', 'operator_exclude', 'email_override'):
            with self.subTest(condition=condition):
                artifact = self.requested_artifact()
                p = artifact.snapshot['profiles'][1]
                if condition == 'paused': p['is_active'] = False
                elif condition == 'minor': p['age'] = 17
                elif condition == 'no_favorites': p['favorites'] = []
                elif condition == 'review_account': artifact.snapshot['review_accounts'] = [{'user_id': 'b'}]
                elif condition == 'report': artifact.snapshot['pending_reports'] = [{'reported_id': 'b'}]
                elif condition == 'owner_hold': artifact.policy['held_user_ids'] = {'b': 'Hold'}
                elif condition == 'operator_exclude': artifact.policy['excluded_user_ids'] = {'b': 'Operator exclusion'}
                elif condition == 'email_override': artifact.policy['email_only_user_ids'] = ['b']
                artifact.policy['requested_pairs'][0]['profile_sha256']['b'] = digest(p)
                excluded, _ = independent_identities(artifact.snapshot, artifact.policy)
                self.assertIn('b', excluded)

    def test_requested_pair_reserves_both_endpoints_in_independent_graph(self):
        artifact = self.requested_artifact()
        people = {p['user_id']: p for p in artifact.snapshot['profiles']}
        graph = independent_hard_graph(people, set(people), artifact.policy, set(), set())
        self.assertEqual(graph['by_type'], {'romance': 1})
        self.assertEqual(graph['degrees'], {'a': 1, 'b': 1})
        self.assertFalse(independent_hard_eligible(people['a'], people['c'], 'romance', artifact.policy, set(), set()))
        artifact.plan['matches'].append(artifact.match({**artifact.edges[0], 'b': 'c', 'owner_requested_pair': False, 'contact_review_user_ids': []}, 1))
        self.assertRejected(artifact, 'requested_pair_exclusive_assignment')

    def test_requested_pair_still_respects_age_gender_blocks_history_and_type(self):
        for condition in ('age', 'gender', 'block', 'history', 'type', 'manual_exclude'):
            with self.subTest(condition=condition):
                artifact = self.requested_artifact()
                people = {p['user_id']: p for p in artifact.snapshot['profiles']}
                previous, blocks = set(), set()
                if condition == 'age': people['b']['age_min'] = 40
                elif condition == 'gender': people['b']['interested_in'] = ['man']
                elif condition == 'block': blocks.add(frozenset('ab'))
                elif condition == 'history': previous.add(frozenset('ab'))
                elif condition == 'type': people['b']['intents'] = ['friends']
                elif condition == 'manual_exclude': artifact.policy['manual_pair_decisions'] = {'romance|a|b': {'decision': 'exclude'}}
                artifact.policy['requested_pairs'][0]['profile_sha256'] = {u: digest(people[u]) for u in 'ab'}
                self.assertFalse(independent_hard_eligible(people['a'], people['b'], 'romance', artifact.policy, previous, blocks))
                graph = independent_hard_graph(people, set(people), artifact.policy, previous, blocks)
                self.assertEqual(graph['edge_count'], 0)

    def test_requested_pair_must_be_present_and_cannot_be_released_or_mislabeled(self):
        artifact = self.requested_artifact()
        artifact.plan['matches'] = []
        self.assertRejected(artifact, 'requested_pair_included_exactly_once')
        for field, value, label in [('owner_requested_pair', False, 'owner_requested_pair_disclosed'),
                                    ('contact_review_user_ids', [], 'contact_review_users_truthful'),
                                    ('status', 'needs_book_review', 'review_status_and_release_boundary'),
                                    ('release_authorized', True, 'review_status_and_release_boundary')]:
            with self.subTest(field=field):
                artifact = self.requested_artifact()
                artifact.plan['matches'][0][field] = value
                self.assertRejected(artifact, label)
        artifact = self.requested_artifact()
        artifact.policy['release_authorized'] = True
        self.assertRejected(artifact, 'requested_contact_hold_is_private_only')

    def test_requested_pair_contract_rejects_duplicate_endpoints(self):
        artifact = self.requested_artifact()
        people = {p['user_id']: p for p in artifact.snapshot['profiles']}
        artifact.policy['requested_pairs'].append({'a': 'a', 'b': 'c', 'type': 'romance',
            'reason': 'Conflicting request.', 'profile_sha256': {u: digest(people[u]) for u in 'ac'}, 'contact_hold_user_ids': []})
        self.assertRejected(artifact, 'requested_pair_endpoints_disjoint')


if __name__ == '__main__':
    unittest.main()
