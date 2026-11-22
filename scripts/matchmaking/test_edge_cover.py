import itertools
import unittest

from edge_cover import SparseCollector, allocate_edge_cover, independently_check


def edge(a, b, score=5000, kind="friends"):
    return {"a": str(a), "b": str(b), "type": kind, "score_integer": score,
            "boundary_review_required": False, "age_gap_years": 0}


class EdgeCoverTests(unittest.TestCase):
    def test_all_graphs_on_five_vertices(self):
        pairs = list(itertools.combinations(range(5), 2))
        for mask in range(1 << len(pairs)):
            edges = [edge(a, b, 1000 + index * 73) for index, (a, b) in enumerate(pairs) if mask & (1 << index)]
            selected, report = allocate_edge_cover(edges)
            self.assertTrue(report["passed"], mask)
            self.assertEqual({u for row in edges for u in (row["a"], row["b"])},
                             {u for index in selected for u in (edges[index]["a"], edges[index]["b"])}, mask)
            self.assertTrue(report["every_pair_has_a_sole_recipient"], mask)

    def test_star_high_load_is_disclosed(self):
        edges = [edge("hub", i) for i in range(9)]
        selected, report = allocate_edge_cover(edges)
        self.assertEqual(len(selected), 9)
        self.assertEqual(report["maximum_total"], 9)
        self.assertEqual(report["heavy_helpers_over_three"][0]["user_id"], "hub")
        self.assertEqual(report["extra_per_type_introductions"], 8)

    def test_typed_duplicates_select_one_pair(self):
        edges = [edge("a", "b", 5000), edge("a", "b", 6000, "romance")]
        selected, report = allocate_edge_cover(edges)
        self.assertEqual(selected, [1])
        self.assertTrue(report["passed"])

    def test_sparse_stream_retains_all_nonisolated_vertices(self):
        collector = SparseCollector(quality_k=1, exploration_k=1)
        for a, b in itertools.combinations(range(30), 2):
            collector.add(edge(a, b, 10000 - a - b))
        edges, report = collector.finish()
        self.assertEqual(report["input_vertices"], 30)
        self.assertEqual(report["retained_vertices"], 30)
        self.assertLess(len(edges), report["input_edges"])
        _, allocation = allocate_edge_cover(edges, collector.degrees)
        self.assertEqual(allocation["people"], 30)

    def test_stream_determinism_is_independent_of_input_order(self):
        edges = [edge(a, b, 5000) for a, b in itertools.combinations(range(20), 2)]
        collectors = [SparseCollector(2, 2), SparseCollector(2, 2)]
        for row in edges:
            collectors[0].add(row)
        for row in reversed(edges):
            collectors[1].add(row)
        outputs = [collector.finish()[0] for collector in collectors]
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(allocate_edge_cover(outputs[0])[0], allocate_edge_cover(outputs[1])[0])

    def test_frozen_target_rule_requires_explicit_supersession(self):
        row = {**edge("a", "b"), "first_introduction_rescue": True, "rescue_target_user_ids": ["a"]}
        with self.assertRaises(ValueError):
            allocate_edge_cover([row])

    def test_independent_check_rejects_nonsole_middle_edge(self):
        edges = [edge(0, 1), edge(1, 2), edge(2, 3)]
        report = independently_check(edges, [0, 1, 2])
        self.assertFalse(report["passed"])
        self.assertIn("edge_without_sole_recipient", report["failures"])

    def test_lost_sparse_vertex_is_rejected(self):
        with self.assertRaises(AssertionError):
            allocate_edge_cover([edge(0, 1)], {"0", "1", "2"})
        with self.assertRaises(AssertionError):
            allocate_edge_cover([], {"missing"})


if __name__ == "__main__":
    unittest.main()
