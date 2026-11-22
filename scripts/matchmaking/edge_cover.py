"""Deterministic sparse edge cover for the explicitly authorized uncapped policy.

This module does not decide who is eligible. It consumes already screened edges.
Coverage is exact for all vertices appearing in that input, even when the input
is sparsified, because sparse collection retains an incident edge for each one.
Matching cardinality is exact on the retained graph; quality and global helper
load are heuristic. Attachment load and quality are optimized for the fixed
matching. Every resulting connected component is a star, so every edge has a
sole-introduction endpoint. This does NOT support rescue rules requiring a
specific frozen endpoint to be sole: those rules must first be superseded by the
user-authorized any-final-sole-recipient policy.
"""
from __future__ import annotations

import collections
import hashlib
import heapq
import json
import math
import time
from pathlib import Path

import networkx as nx
from ortools.graph.python import max_flow, min_cost_flow

KIND_ORDER = {"romance": 0, "friends": 1, "business_partners": 2}


def edge_key(edge):
    return (edge["type"], *sorted((edge["a"], edge["b"])))


def pair_key(edge):
    return tuple(sorted((edge["a"], edge["b"])))


def quality(edge):
    """Prefer reviewed/clear evidence, then the caller's books/age fit score."""
    return (
        not bool(edge.get("boundary_review_required")),
        int(edge.get("score_integer", round(edge.get("score", 0) * 10000))),
        -float(edge.get("age_gap_years", 0)),
        int(edge.get("priority_people", 0)),
        -KIND_ORDER.get(edge["type"], 99),
    )


def scalar_quality(edge):
    # Score is bounded to [0, 1] in the source engine. The unflagged bonus is
    # deliberate and disclosed; it is not a compatibility probability.
    score = int(edge.get("score_integer", round(edge.get("score", 0) * 10000)))
    return score + (10001 if not edge.get("boundary_review_required") else 0)


class SparseCollector:
    """Streaming union of top-quality and deterministic exploration candidates.

    The exploration reservoir prevents all members with similar tastes from
    keeping only the same small set of popular helpers. No random state is used.
    Memory is O(vertices * (quality_k + exploration_k)); edges are not copied.
    """

    def __init__(self, quality_k=12, exploration_k=8):
        if quality_k < 1 or exploration_k < 0:
            raise ValueError("quality_k must be positive; exploration_k nonnegative")
        self.quality_k = quality_k
        self.exploration_k = exploration_k
        self.best = collections.defaultdict(list)
        self.explore = collections.defaultdict(list)
        self.degrees = collections.Counter()
        self.type_degrees = collections.Counter()
        self.edges_seen = 0
        self._signature = hashlib.sha256()

    @staticmethod
    def _push(heap, size, rank, key, edge):
        row = (rank, key, edge)
        if len(heap) < size:
            heapq.heappush(heap, row)
        elif (rank, key) > heap[0][:2]:
            heapq.heapreplace(heap, row)

    def add(self, edge):
        if edge["a"] == edge["b"]:
            raise ValueError("Self edge passed to allocation")
        key = edge_key(edge)
        raw_key = "|".join(key).encode()
        self._signature.update(raw_key + b"\n")
        exploration_rank = int.from_bytes(hashlib.blake2b(raw_key, digest_size=8).digest(), "big")
        for user in (edge["a"], edge["b"]):
            self.degrees[user] += 1
            self.type_degrees[(user, edge["type"])] += 1
            self._push(self.best[user], self.quality_k, quality(edge), key, edge)
            if self.exploration_k:
                self._push(self.explore[user], self.exploration_k, exploration_rank, key, edge)
        self.edges_seen += 1

    def finish(self):
        retained = {}
        for tables in (self.best, self.explore):
            for heap in tables.values():
                for _, key, edge in heap:
                    retained[key] = edge
        rows = [retained[key] for key in sorted(retained)]
        sparse_vertices = {user for edge in rows for user in (edge["a"], edge["b"])}
        if sparse_vertices != set(self.degrees):
            raise AssertionError("Sparsification lost a nonisolated input vertex")
        return rows, {
            "method": "union_of_top_quality_and_deterministic_hash_reservoir_per_person",
            "quality_k": self.quality_k,
            "exploration_k": self.exploration_k,
            "input_edges": self.edges_seen,
            "retained_edges": len(rows),
            "input_vertices": len(self.degrees),
            "retained_vertices": len(sparse_vertices),
            "lost_nonisolated_vertices": 0,
            "ordered_input_keys_sha256": self._signature.hexdigest(),
            "coverage_preserved_exactly": True,
            "quality_and_minimum_pair_count_may_change": len(rows) < self.edges_seen,
        }


def sparsify(edges, quality_k=12, exploration_k=8):
    collector = SparseCollector(quality_k, exploration_k)
    for edge in edges:
        collector.add(edge)
    return collector.finish()


def _build_graph(edges):
    chosen_per_pair = {}
    for index, edge in enumerate(edges):
        pair = pair_key(edge)
        old = chosen_per_pair.get(pair)
        if old is None or (quality(edge), edge_key(edge)) > (quality(edges[old]), edge_key(edges[old])):
            chosen_per_pair[pair] = index
    graph = nx.Graph()
    graph.add_nodes_from(sorted({user for pair in chosen_per_pair for user in pair}))
    # Traversal order is deterministic, with better candidates visited first.
    order = sorted(chosen_per_pair.items(), key=lambda item: (quality(edges[item[1]]), item[0]), reverse=True)
    for pair, index in order:
        graph.add_edge(*pair, index=index, weight=scalar_quality(edges[index]))
    return graph


def _improve_matching_quality(graph, matching, passes=2):
    """Strictly improve simple 4-cycle swaps without changing matching coverage."""
    partner = {a: b for pair in matching for a, b in (pair, pair[::-1])}
    moves = 0
    order = sorted(graph.edges, key=lambda pair: (-graph.edges[pair]["weight"], tuple(sorted(pair))))
    for _ in range(passes):
        changed = False
        for a, c in order:
            b, d = partner.get(a), partner.get(c)
            if b is None or d is None or len({a, b, c, d}) != 4 or not graph.has_edge(b, d):
                continue
            before = graph[a][b]["weight"] + graph[c][d]["weight"]
            after = graph[a][c]["weight"] + graph[b][d]["weight"]
            if after > before:
                partner.update({a: c, c: a, b: d, d: b})
                moves += 1
                changed = True
        if not changed:
            break
    return {tuple(sorted((a, b))) for a, b in partner.items()}, moves


def _attachment_assignment(graph, matching):
    matched = {user for pair in matching for user in pair}
    leaves = sorted(set(graph) - matched, key=lambda user: (graph.degree[user], user))
    if not leaves:
        return [], {"unmatched_after_matching": 0, "maximum_helper_total_for_fixed_matching": 1,
                    "attachment_assignment": "not_needed"}
    if any(other not in matched for user in leaves for other in graph[user]):
        raise AssertionError("Returned matching is not maximal")
    helpers = sorted({other for user in leaves for other in graph[user]})
    # Each leaf has at least one helper because isolated vertices were omitted.
    node = {user: i + 1 for i, user in enumerate(leaves + helpers)}
    source = 0
    sink = len(node) + 1

    def feasible(capacity):
        flow = max_flow.SimpleMaxFlow()
        for user in leaves:
            flow.add_arc_with_capacity(source, node[user], 1)
            for helper in sorted(graph[user]):
                flow.add_arc_with_capacity(node[user], node[helper], 1)
        for helper in helpers:
            flow.add_arc_with_capacity(node[helper], sink, capacity)
        status = flow.solve(source, sink)
        if status != flow.OPTIMAL:
            raise RuntimeError("Helper-capacity flow failed")
        return flow.optimal_flow() == len(leaves)

    low = max(1, math.ceil(len(leaves) / len(helpers)))
    high = len(leaves)
    while low < high:
        middle = (low + high) // 2
        if feasible(middle):
            high = middle
        else:
            low = middle + 1
    capacity = low
    flow = min_cost_flow.SimpleMinCostFlow()
    max_quality = max(graph[user][helper]["weight"] for user in leaves for helper in graph[user])
    # Score dominates load tie-breaking after the exact maximum load constraint.
    quality_scale = len(leaves) * len(leaves) + 1
    attachment_arcs = []
    for user in leaves:
        flow.add_arc_with_capacity_and_unit_cost(source, node[user], 1, 0)
        for helper in sorted(graph[user]):
            cost = (max_quality - graph[user][helper]["weight"]) * quality_scale
            arc = flow.add_arc_with_capacity_and_unit_cost(node[user], node[helper], 1, cost)
            attachment_arcs.append((arc, user, helper))
    for helper in helpers:
        for load in range(1, min(capacity, sum(helper in graph[user] for user in leaves)) + 1):
            flow.add_arc_with_capacity_and_unit_cost(node[helper], sink, 1, 2 * load - 1)
    flow.set_node_supply(source, len(leaves))
    flow.set_node_supply(sink, -len(leaves))
    if flow.solve() != flow.OPTIMAL:
        raise RuntimeError("Helper assignment cost flow failed")
    attachments = [tuple(sorted((user, helper))) for arc, user, helper in attachment_arcs if flow.flow(arc)]
    return attachments, {
        "unmatched_after_matching": len(leaves),
        "maximum_helper_total_for_fixed_matching": capacity + 1,
        "attachment_assignment": "exact_minimum_maximum_load_then_quality_then_squared_load_for_fixed_matching",
    }


def independently_check(edges, selected, expected_nonisolated_vertices=None):
    rows = [edges[index] for index in selected]
    degrees = collections.Counter(user for edge in rows for user in (edge["a"], edge["b"]))
    slots = collections.Counter((user, edge["type"]) for edge in rows for user in (edge["a"], edge["b"]))
    credits = collections.Counter((user, edge["type"]) for edge in rows
                                  for user, other in ((edge["a"], edge["b"]), (edge["b"], edge["a"]))
                                  if degrees[other] == 1)
    pairs = [pair_key(edge) for edge in rows]
    expected = set(expected_nonisolated_vertices) if expected_nonisolated_vertices is not None else {
        user for edge in edges for user in (edge["a"], edge["b"])}
    failures = []
    if len(set(selected)) != len(selected):
        failures.append("duplicate_selected_index")
    if len(set(pairs)) != len(pairs):
        failures.append("duplicate_pair_across_types")
    if any(a == b for a, b in pairs):
        failures.append("self_pair")
    if set(degrees) != expected:
        failures.append("nonisolated_vertex_coverage_mismatch")
    if any(degrees[a] != 1 and degrees[b] != 1 for a, b in pairs):
        failures.append("edge_without_sole_recipient")
    if any(credits[slot] < count - 1 for slot, count in slots.items()):
        failures.append("extra_per_type_introduction_without_sole_recipient_credit")
    return {
        "passed": not failures,
        "failures": failures,
        "people": len(degrees),
        "pairs": len(rows),
        "maximum_total": max(degrees.values(), default=0),
        "maximum_per_type": max(slots.values(), default=0),
        "total_degree_histogram": dict(sorted(collections.Counter(degrees.values()).items())),
        "extra_per_type_introductions": sum(max(0, n - 1) for n in slots.values()),
        "everyone_in_input_with_at_least_one_edge_is_covered": set(degrees) == expected,
        "every_pair_has_a_sole_recipient": not any(degrees[a] != 1 and degrees[b] != 1 for a, b in pairs),
        "heavy_helpers_over_three": [
            {"user_id": user, "total": count,
             "by_type": {kind: slots[(user, kind)] for kind in KIND_ORDER if slots[(user, kind)]}}
            for user, count in sorted(degrees.items(), key=lambda item: (-item[1], item[0])) if count > 3
        ],
    }


def allocate_edge_cover(edges, expected_nonisolated_vertices=None, weighted_matching=False, quality_passes=2):
    """Return indices into edges and a self-contained audit/optimization report."""
    started = time.monotonic()
    if any(edge.get("first_introduction_rescue") and edge.get("rescue_target_user_ids") for edge in edges):
        raise ValueError("Frozen rescue targets must be explicitly superseded before uncapped star allocation")
    graph = _build_graph(edges)
    if not graph:
        report = independently_check(edges, [], expected_nonisolated_vertices)
        if not report["passed"]:
            raise AssertionError(report)
        return [], report
    matching = nx.max_weight_matching(graph, maxcardinality=True,
                                      weight="weight" if weighted_matching else "unit_weight_not_present")
    matching = {tuple(sorted(pair)) for pair in matching}
    matching_seconds = time.monotonic() - started
    moves = 0
    if not weighted_matching and quality_passes:
        matching, moves = _improve_matching_quality(graph, matching, quality_passes)
    attachments, attachment_report = _attachment_assignment(graph, matching)
    pairs = matching | set(attachments)
    # For an actual maximum matching, both endpoints of a matched edge cannot
    # receive distinct unmatched leaves (that would be an augmenting path).
    # Thus this cover is already a union of stars; independently check below.
    selected = sorted(graph[a][b]["index"] for a, b in pairs)
    check = independently_check(edges, selected, expected_nonisolated_vertices)
    if not check["passed"]:
        raise AssertionError(check)
    if len(selected) != len(graph) - len(matching):
        raise AssertionError("Minimum edge cover cardinality identity failed")
    report = {
        **check,
        **attachment_report,
        "algorithm": "maximum_cardinality_matching_then_capacitated_min_cost_star_attachment",
        "matching_pairs": len(matching),
        "matching_covered_people": 2 * len(matching),
        "minimum_pair_count_on_retained_graph": len(graph) - len(matching),
        "minimum_pair_count_on_full_input_graph_proven": len(selected) == math.ceil(len(graph) / 2),
        "maximum_achievable_people_with_input_edges": len(graph),
        "unique_coverage_optimal_on_full_input_graph": expected_nonisolated_vertices is not None,
        "coverage_proof": "The collector retains every nonisolated full-input vertex, and the returned star cover covers exactly that set; no input edge can cover an isolated vertex.",
        "matching_cardinality_exact_on_retained_graph": True,
        "matching_quality_exact_on_retained_graph": bool(weighted_matching),
        "quality_improvement_four_cycle_swaps": moves,
        "global_minimum_helper_load_proven": False,
        "matching_seconds": round(matching_seconds, 3),
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "scope": "Already screened candidate edges; no eligibility, consent, identity, history or block rules are weakened here.",
        "sole_rule": "Every final selected edge has at least one endpoint with exactly one total introduction; no frozen target-specific sole requirements supported.",
    }
    return selected, report


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("candidates", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--supersede-frozen-rescue-targets", action="store_true")
    parser.add_argument("--weighted", action="store_true")
    args = parser.parse_args()
    collector = SparseCollector()
    for line in args.candidates.open():
        edge = json.loads(line)
        if args.supersede_frozen_rescue_targets:
            edge = {**edge, "rescue_target_user_ids": []}
        collector.add(edge)
    edges, sparse_report = collector.finish()
    selected, report = allocate_edge_cover(edges, set(collector.degrees), args.weighted)
    result = {"sparsification": sparse_report, "allocation": report,
              "selected_keys": [edge_key(edges[index]) for index in selected]}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"sparsification": sparse_report,
                      "allocation": {key: value for key, value in report.items() if key != "heavy_helpers_over_three"}}))


if __name__ == "__main__":
    main()
