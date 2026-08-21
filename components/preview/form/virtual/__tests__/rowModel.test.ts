/**
 * rowModel unit tests.
 *
 * These tests pin down the shape of the flattened row list for every case the
 * walker must cover:
 *
 * - A flat form (only leaf fields).
 * - A form with a single group + children.
 * - A form with a repeat + children.
 * - Nested groups (depth > 1).
 * - Collapsed groups (children omitted, bracket still emitted).
 * - Empty groups (empty-container placeholder).
 * - Insertion-point inclusion/exclusion toggle.
 * - Missing order entries (defensive: walker skips dangling uuids).
 *
 * The walker has no React dependencies, so tests run against hand-built
 * fixtures instead of the Zustand store.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { Uuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import { buildFormRows, type CollapseState, type RowSource } from "../rowModel";

// ── Fixture helpers ────────────────────────────────────────────────────

const F = testUuid("form-0000-0000-0000-000000000000");
const G = (n: number) => testUuid(`grp${n}-0000-0000-0000-000000000000`);
const Q = (n: number) => testUuid(`qst${n}-0000-0000-0000-000000000000`);
const R = (n: number) => testUuid(`rep${n}-0000-0000-0000-000000000000`);

function text(uuid: Uuid, id: string): Field {
	return { uuid, id, kind: "text", label: id } as unknown as Field;
}

function group(uuid: Uuid, id: string): Field {
	return { uuid, id, kind: "group", label: id } as unknown as Field;
}

function repeat(uuid: Uuid, id: string): Field {
	return { uuid, id, kind: "repeat", label: id } as unknown as Field;
}

const EMPTY: CollapseState = new Set<Uuid>();

/** Build a RowSource for tests. The row walker consumes domain entities
 *  keyed by uuid: the same shape the blueprint store exposes via its
 *  `fields` / `fieldOrder` maps. */
function src(
	fields: Record<Uuid, Field>,
	order: Record<Uuid, Uuid[]>,
): RowSource {
	return { fields, fieldOrder: order };
}

// ── Flat form ──────────────────────────────────────────────────────────

describe("buildFormRows — flat form", () => {
	it("emits insertion + field rows with trailing insertion when edit mode", () => {
		const rows = buildFormRows(
			src(
				{ [Q(1)]: text(Q(1), "a"), [Q(2)]: text(Q(2), "b") },
				{ [F]: [Q(1), Q(2)] },
			),
			F,
			{ includeInsertionPoints: true, collapsed: EMPTY },
		);

		// ins(0), q1, ins(1), q2, ins(2)
		expect(rows).toHaveLength(5);
		expect(rows[0]).toMatchObject({
			kind: "insertion",
			parentUuid: F,
			beforeIndex: 0,
			depth: 0,
		});
		expect(rows[1]).toMatchObject({ kind: "field", uuid: Q(1), depth: 0 });
		expect(rows[2]).toMatchObject({
			kind: "insertion",
			parentUuid: F,
			beforeIndex: 1,
		});
		expect(rows[3]).toMatchObject({ kind: "field", uuid: Q(2) });
		expect(rows[4]).toMatchObject({
			kind: "insertion",
			parentUuid: F,
			beforeIndex: 2,
		});
	});

	it("omits insertion points when includeInsertionPoints is false", () => {
		const rows = buildFormRows(
			src({ [Q(1)]: text(Q(1), "a") }, { [F]: [Q(1)] }),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("field");
	});

	it("empty root form produces no rows (no empty-container at depth 0)", () => {
		const rows = buildFormRows(src({}, { [F]: [] }), F, {
			includeInsertionPoints: true,
			collapsed: EMPTY,
		});
		// Only the leading insertion-point row for the empty form root.
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("insertion");
	});

	it("missing fieldOrder entry yields just the leading insertion", () => {
		const rows = buildFormRows(src({}, {}), F, {
			includeInsertionPoints: true,
			collapsed: EMPTY,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("insertion");
	});
});

// ── Groups ─────────────────────────────────────────────────────────────

describe("buildFormRows — groups", () => {
	it("brackets a group with open/close and emits children at depth+1", () => {
		const rows = buildFormRows(
			src(
				{
					[G(1)]: group(G(1), "personal"),
					[Q(1)]: text(Q(1), "name"),
				},
				{ [F]: [G(1)], [G(1)]: [Q(1)] },
			),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);

		// open(G1), q1 (depth=1), close(G1)
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({
			kind: "group-open",
			uuid: G(1),
			depth: 0,
			collapsed: false,
		});
		expect(rows[1]).toMatchObject({
			kind: "field",
			uuid: Q(1),
			depth: 1,
		});
		expect(rows[2]).toMatchObject({
			kind: "group-close",
			uuid: G(1),
			depth: 0,
		});
	});

	it("empty group emits an empty-container row between brackets", () => {
		const rows = buildFormRows(
			src({ [G(1)]: group(G(1), "empty") }, { [F]: [G(1)], [G(1)]: [] }),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows.map((r) => r.kind)).toEqual([
			"group-open",
			"empty-container",
			"group-close",
		]);
		const empty = rows[1];
		if (empty.kind !== "empty-container") throw new Error("kind");
		expect(empty.parentUuid).toBe(G(1));
		expect(empty.depth).toBe(1);
	});

	it("collapsed group omits children but still emits matching close", () => {
		const rows = buildFormRows(
			src(
				{ [G(1)]: group(G(1), "g"), [Q(1)]: text(Q(1), "a") },
				{ [F]: [G(1)], [G(1)]: [Q(1)] },
			),
			F,
			{ includeInsertionPoints: false, collapsed: new Set([G(1)]) },
		);
		expect(rows.map((r) => r.kind)).toEqual(["group-open", "group-close"]);
		const open = rows[0];
		if (open.kind !== "group-open") throw new Error("kind");
		expect(open.collapsed).toBe(true);
	});

	it("nested groups produce the expected bracket + depth sequence", () => {
		// F → G1 → G2 → Q1
		const rows = buildFormRows(
			src(
				{
					[G(1)]: group(G(1), "outer"),
					[G(2)]: group(G(2), "inner"),
					[Q(1)]: text(Q(1), "leaf"),
				},
				{ [F]: [G(1)], [G(1)]: [G(2)], [G(2)]: [Q(1)] },
			),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);

		const summary = rows.map((r) => ({ kind: r.kind, depth: r.depth }));
		expect(summary).toEqual([
			{ kind: "group-open", depth: 0 },
			{ kind: "group-open", depth: 1 },
			{ kind: "field", depth: 2 },
			{ kind: "group-close", depth: 1 },
			{ kind: "group-close", depth: 0 },
		]);
	});
});

// ── Repeats ────────────────────────────────────────────────────────────

describe("buildFormRows — repeats", () => {
	it("treats a repeat like a group (open/close brackets + depth)", () => {
		const rows = buildFormRows(
			src(
				{ [R(1)]: repeat(R(1), "visits"), [Q(1)]: text(Q(1), "note") },
				{ [F]: [R(1)], [R(1)]: [Q(1)] },
			),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows.map((r) => r.kind)).toEqual([
			"group-open",
			"field",
			"group-close",
		]);
	});
});

// ── Insertion-point layout ─────────────────────────────────────────────

describe("buildFormRows — insertion point layout", () => {
	it("interleaves insertion points around group brackets at parent depth", () => {
		const rows = buildFormRows(
			src({ [G(1)]: group(G(1), "g") }, { [F]: [G(1)], [G(1)]: [] }),
			F,
			{ includeInsertionPoints: true, collapsed: EMPTY },
		);
		// ins(F,0), open(G1), ins(G1,0), empty-container, close(G1), ins(F,1)
		expect(rows.map((r) => r.kind)).toEqual([
			"insertion",
			"group-open",
			"insertion",
			"empty-container",
			"group-close",
			"insertion",
		]);
		// Outer insertion points are at depth 0, inner at depth 1.
		if (rows[0].kind === "insertion") expect(rows[0].depth).toBe(0);
		if (rows[2].kind === "insertion") expect(rows[2].depth).toBe(1);
		if (rows[5].kind === "insertion") expect(rows[5].depth).toBe(0);
	});

	it("beforeIndex tracks sibling position, not row index", () => {
		const rows = buildFormRows(
			src(
				{ [Q(1)]: text(Q(1), "a"), [Q(2)]: text(Q(2), "b") },
				{ [F]: [Q(1), Q(2)] },
			),
			F,
			{ includeInsertionPoints: true, collapsed: EMPTY },
		);
		const insertions = rows.filter(
			(r): r is Extract<typeof r, { kind: "insertion" }> =>
				r.kind === "insertion",
		);
		expect(insertions.map((r) => r.beforeIndex)).toEqual([0, 1, 2]);
	});
});

// ── Defensive: dangling refs ──────────────────────────────────────────

describe("buildFormRows — defensive", () => {
	it("skips uuids in fieldOrder that have no entity", () => {
		const rows = buildFormRows(
			src({ [Q(1)]: text(Q(1), "present") }, { [F]: [Q(1), Q(2)] }),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe("field");
	});
});

// ── Identity / key stability ──────────────────────────────────────────

describe("buildFormRows — row id stability", () => {
	it("row ids are stable across reruns (no wall-clock / random input)", () => {
		const s = src(
			{ [Q(1)]: text(Q(1), "a"), [Q(2)]: text(Q(2), "b") },
			{ [F]: [Q(1), Q(2)] },
		);
		const a = buildFormRows(s, F, {
			includeInsertionPoints: true,
			collapsed: EMPTY,
		});
		const b = buildFormRows(s, F, {
			includeInsertionPoints: true,
			collapsed: EMPTY,
		});
		expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
	});

	it("field row id reflects the field uuid, not its position", () => {
		// Reorder the same fields, their row ids must not change.
		const fields = {
			[Q(1)]: text(Q(1), "a"),
			[Q(2)]: text(Q(2), "b"),
		};
		const before = buildFormRows(src(fields, { [F]: [Q(1), Q(2)] }), F, {
			includeInsertionPoints: false,
			collapsed: EMPTY,
		});
		const after = buildFormRows(src(fields, { [F]: [Q(2), Q(1)] }), F, {
			includeInsertionPoints: false,
			collapsed: EMPTY,
		});
		const q1Before = before.find((r) => r.kind === "field" && r.uuid === Q(1));
		const q1After = after.find((r) => r.kind === "field" && r.uuid === Q(1));
		expect(q1Before?.id).toBe(q1After?.id);
	});
});

// ── Sections (pages) ───────────────────────────────────────────────────

const S = (n: number) => testUuid(`sec${n}-0000-0000-0000-000000000000`);

function section(uuid: Uuid, id: string): Field {
	return { uuid, id, kind: "section", label: id } as unknown as Field;
}

describe("buildFormRows — sections", () => {
	const fields = {
		[S(1)]: section(S(1), "intro"),
		[S(2)]: section(S(2), "vitals"),
		[Q(1)]: text(Q(1), "a"),
		[Q(2)]: text(Q(2), "b"),
		[G(1)]: group(G(1), "g"),
		[Q(3)]: text(Q(3), "c"),
	};
	const order = {
		[F]: [S(1), S(2)],
		[S(1)]: [Q(1), G(1)],
		[G(1)]: [Q(2)],
		[S(2)]: [Q(3)],
	};

	it("emits a heading per page with k-of-n, children at depth 0, no close row", () => {
		const rows = buildFormRows(src(fields, order), F, {
			includeInsertionPoints: false,
			collapsed: EMPTY,
		});
		expect(rows.map((r) => r.kind)).toEqual([
			"section-header",
			"field",
			"group-open",
			"field",
			"group-close",
			"section-header",
			"field",
		]);
		expect(rows[0]).toMatchObject({
			kind: "section-header",
			uuid: S(1),
			parentUuid: F,
			siblingIndex: 0,
			index: 0,
			count: 2,
			depth: 0,
		});
		expect(rows[5]).toMatchObject({ uuid: S(2), index: 1, count: 2 });
		// A page is a break, not an indent: its children sit at depth 0 and
		// a group inside it indents from there.
		expect(rows[1]).toMatchObject({ kind: "field", uuid: Q(1), depth: 0 });
		expect(rows[2]).toMatchObject({ kind: "group-open", uuid: G(1), depth: 0 });
		expect(rows[3]).toMatchObject({ kind: "field", uuid: Q(2), depth: 1 });
		expect(rows.some((r) => r.kind === "group-close" && r.uuid === S(1))).toBe(
			false,
		);
	});

	it("puts the page's insertion gaps inside the page and the page breaks at the root", () => {
		const rows = buildFormRows(src(fields, order), F, {
			includeInsertionPoints: true,
			collapsed: EMPTY,
		});
		const ids = rows.map((r) => r.id);
		// root gap, heading 1, page-1 gaps around its children, root gap,
		// heading 2, page-2 gaps, root gap.
		expect(ids[0]).toBe(`ins:${F}:0`);
		expect(ids[1]).toBe(`section:${S(1)}`);
		expect(ids[2]).toBe(`ins:${S(1)}:0`);
		const afterPageOne = ids.indexOf(`ins:${F}:1`);
		expect(afterPageOne).toBeGreaterThan(2);
		expect(ids[afterPageOne - 1]).toBe(`ins:${S(1)}:2`);
		expect(ids[afterPageOne + 1]).toBe(`section:${S(2)}`);
		expect(ids.at(-1)).toBe(`ins:${F}:2`);
		const insideRows = rows.filter(
			(r) => r.kind === "insertion" && r.parentUuid === S(1),
		);
		expect(insideRows.every((r) => r.depth === 0)).toBe(true);
	});

	it("gives an empty page a section-variant placeholder", () => {
		const rows = buildFormRows(
			src(
				{ [S(1)]: section(S(1), "intro"), [S(2)]: section(S(2), "vitals") },
				{ [F]: [S(1), S(2)], [S(1)]: [], [S(2)]: [] },
			),
			F,
			{ includeInsertionPoints: true, collapsed: EMPTY },
		);
		expect(rows.map((r) => r.kind)).toEqual([
			"insertion",
			"section-header",
			"insertion",
			"empty-container",
			"insertion",
			"section-header",
			"insertion",
			"empty-container",
			"insertion",
		]);
		expect(rows[3]).toMatchObject({
			kind: "empty-container",
			parentUuid: S(1),
			depth: 0,
			variant: "section",
		});
	});

	it("keeps the container variant for an empty group", () => {
		const rows = buildFormRows(
			src({ [G(1)]: group(G(1), "g") }, { [F]: [G(1)], [G(1)]: [] }),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows[1]).toMatchObject({
			kind: "empty-container",
			variant: "container",
			depth: 1,
		});
	});

	it("counts only sections for k-of-n when the root is briefly mixed", () => {
		// The gate never commits this shape, but a replay race can show it
		// for a frame: the heading still says 1 of 1 rather than 1 of 2.
		const rows = buildFormRows(
			src(
				{ [S(1)]: section(S(1), "intro"), [Q(1)]: text(Q(1), "a") },
				{ [F]: [S(1), Q(1)], [S(1)]: [] },
			),
			F,
			{ includeInsertionPoints: false, collapsed: EMPTY },
		);
		expect(rows[0]).toMatchObject({ kind: "section-header", count: 1 });
		expect(rows.at(-1)).toMatchObject({ kind: "field", uuid: Q(1) });
	});
});
