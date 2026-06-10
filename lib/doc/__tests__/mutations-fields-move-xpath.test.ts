import { describe, expect, it, vi } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

// Fixed UUIDs for all entities in the fixture.
const MOD = asUuid("module-1-uuid");
const FORM = asUuid("form-1-uuid");
const GRP1 = asUuid("g1-0000-0000-0000-000000000000");
const GRP2 = asUuid("g2-0000-0000-0000-000000000000");
const SRC = asUuid("src-0000-0000-0000-000000000000");
const REF = asUuid("ref-0000-0000-0000-000000000000");

/**
 * Build a normalized `BlueprintDoc` fixture for XPath-rewrite tests.
 *
 * Structure:
 *   M → F → grp1 { source }
 *           grp2 {}
 *           ref (hidden; calculate references /data/grp1/source)
 *
 * Moving `source` from grp1 into grp2 should update ref's calculate XPath.
 * `ref` is a hidden field because `calculate` lives on the hidden kind
 * only (visible kinds carry `default_value` instead) — the rewrite pass
 * walks the registry's per-kind slot projection, so the fixture has to
 * put the expression where the schema actually allows it.
 */
function fixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "m", name: "M" },
		},
		forms: {
			[FORM]: { uuid: FORM, id: "f", name: "F", type: "survey" },
		},
		fields: {
			[GRP1]: {
				uuid: GRP1,
				id: "grp1",
				kind: "group",
				label: "G1",
			} as BlueprintDoc["fields"][typeof GRP1],
			[GRP2]: {
				uuid: GRP2,
				id: "grp2",
				kind: "group",
				label: "G2",
			} as BlueprintDoc["fields"][typeof GRP2],
			[SRC]: {
				uuid: SRC,
				id: "source",
				kind: "text",
				label: "Source",
			} as BlueprintDoc["fields"][typeof SRC],
			[REF]: {
				uuid: REF,
				id: "ref",
				kind: "hidden",
				calculate: "/data/grp1/source + 1",
			} as BlueprintDoc["fields"][typeof REF],
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: {
			[FORM]: [GRP1, GRP2, REF],
			[GRP1]: [SRC],
			[GRP2]: [],
		},
		fieldParent: {},
	};
}

describe("moveField + path rewrite", () => {
	it("rewrites absolute-path references when a field moves across groups", () => {
		const store = createBlueprintDocStore();
		store.getState().load(fixture());

		store.getState().applyMany([
			{
				kind: "moveField",
				uuid: SRC,
				toParentUuid: GRP2,
				toIndex: 0,
			},
		]);

		const ref = store.getState().fields[REF] as
			| { calculate?: string }
			| undefined;
		expect(ref?.calculate).toBe("/data/grp2/source + 1");
	});
});

// ── Moved-container descendants ─────────────────────────────────────

const OUTER = asUuid("out-0000-0000-0000-000000000000");
const GRP = asUuid("grp-0000-0000-0000-000000000000");
const CHILD = asUuid("chd-0000-0000-0000-000000000000");
const WATCH = asUuid("wat-0000-0000-0000-000000000000");
const LABELED = asUuid("lbl-0000-0000-0000-000000000000");

/**
 * M → F → outer {}
 *         grp { child }
 *         watch (hidden; calculate references grp's DESCENDANT in both
 *                spellings)
 *         labeled (text; label prose embeds the same hashtag ref)
 *
 * Indenting `grp` into `outer` must re-anchor the descendant refs on
 * both the XPath and prose surfaces.
 */
function containerFixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "m", name: "M" },
		},
		forms: {
			[FORM]: { uuid: FORM, id: "f", name: "F", type: "survey" },
		},
		fields: {
			[OUTER]: {
				uuid: OUTER,
				id: "outer",
				kind: "group",
				label: "Outer",
			} as BlueprintDoc["fields"][typeof OUTER],
			[GRP]: {
				uuid: GRP,
				id: "grp",
				kind: "group",
				label: "Grp",
			} as BlueprintDoc["fields"][typeof GRP],
			[CHILD]: {
				uuid: CHILD,
				id: "child",
				kind: "text",
				label: "Child",
			} as BlueprintDoc["fields"][typeof CHILD],
			[WATCH]: {
				uuid: WATCH,
				id: "watch",
				kind: "hidden",
				calculate: "#form/grp/child = '1' and /data/grp/child != ''",
			} as BlueprintDoc["fields"][typeof WATCH],
			[LABELED]: {
				uuid: LABELED,
				id: "labeled",
				kind: "text",
				label: "Compare with #form/grp/child today",
			} as BlueprintDoc["fields"][typeof LABELED],
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: {
			[FORM]: [OUTER, GRP, WATCH, LABELED],
			[OUTER]: [],
			[GRP]: [CHILD],
		},
		fieldParent: {},
	};
}

describe("moveField re-anchors refs to a moved CONTAINER's descendants", () => {
	it("rewrites descendant hashtag + absolute refs on XPath surfaces", () => {
		const store = createBlueprintDocStore();
		store.getState().load(containerFixture());
		store
			.getState()
			.applyMany([
				{ kind: "moveField", uuid: GRP, toParentUuid: OUTER, toIndex: 0 },
			]);
		const watch = store.getState().fields[WATCH] as
			| { calculate?: string }
			| undefined;
		expect(watch?.calculate).toBe(
			"#form/outer/grp/child = '1' and /data/outer/grp/child != ''",
		);
	});

	it("rewrites descendant hashtag refs embedded in prose surfaces", () => {
		const store = createBlueprintDocStore();
		store.getState().load(containerFixture());
		store
			.getState()
			.applyMany([
				{ kind: "moveField", uuid: GRP, toParentUuid: OUTER, toIndex: 0 },
			]);
		const labeled = store.getState().fields[LABELED] as
			| { label?: string }
			| undefined;
		expect(labeled?.label).toBe("Compare with #form/outer/grp/child today");
	});
});

// ── Cross-form moves ────────────────────────────────────────────────

const FORM_B = asUuid("form-2-uuid");
const NOTES_A = asUuid("nta-0000-0000-0000-000000000000");
const WATCH_A = asUuid("wta-0000-0000-0000-000000000000");
const NOTES_B = asUuid("ntb-0000-0000-0000-000000000000");
const WATCH_B = asUuid("wtb-0000-0000-0000-000000000000");

/**
 * M → A { notes, watch_a (references /data/notes — A's own `notes`) }
 *     B { notes, watch_b (references /data/notes — B's own `notes`) }
 *
 * A cross-form `moveField` has no defined reference semantics (XPath
 * refs are form-scoped, and both directions can silently CAPTURE a
 * same-named field in whichever form they land), so the reducer
 * warn-and-skips it: nothing moves, nothing is rewritten.
 */
function crossFormFixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[MOD]: { uuid: MOD, id: "m", name: "M" },
		},
		forms: {
			[FORM]: { uuid: FORM, id: "fa", name: "A", type: "survey" },
			[FORM_B]: { uuid: FORM_B, id: "fb", name: "B", type: "survey" },
		},
		fields: {
			[NOTES_A]: {
				uuid: NOTES_A,
				id: "notes",
				kind: "text",
				label: "Notes A",
			} as BlueprintDoc["fields"][typeof NOTES_A],
			[WATCH_A]: {
				uuid: WATCH_A,
				id: "watch_a",
				kind: "hidden",
				calculate: "/data/notes != ''",
			} as BlueprintDoc["fields"][typeof WATCH_A],
			[NOTES_B]: {
				uuid: NOTES_B,
				id: "notes",
				kind: "text",
				label: "Notes B",
			} as BlueprintDoc["fields"][typeof NOTES_B],
			[WATCH_B]: {
				uuid: WATCH_B,
				id: "watch_b",
				kind: "hidden",
				calculate: "/data/notes = 'yes'",
			} as BlueprintDoc["fields"][typeof WATCH_B],
		},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM, FORM_B] },
		fieldOrder: {
			[FORM]: [NOTES_A, WATCH_A],
			[FORM_B]: [NOTES_B, WATCH_B],
		},
		fieldParent: {},
	};
}

describe("moveField across forms is warn-and-skipped (undesigned operation)", () => {
	it("skips a move whose destination is another FORM and leaves the doc unchanged", () => {
		const store = createBlueprintDocStore();
		store.getState().load(crossFormFixture());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const [result] = store
			.getState()
			.applyMany([
				{ kind: "moveField", uuid: NOTES_A, toParentUuid: FORM_B, toIndex: 0 },
			]);

		// Skip convention: warn logged, empty result, nothing mutated.
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		expect(result).toBeUndefined();
		const state = store.getState();
		expect(state.fields[NOTES_A]?.id).toBe("notes");
		expect(state.fieldOrder[FORM]).toEqual([NOTES_A, WATCH_A]);
		expect(state.fieldOrder[FORM_B]).toEqual([NOTES_B, WATCH_B]);
		expect((state.fields[WATCH_A] as { calculate?: string })?.calculate).toBe(
			"/data/notes != ''",
		);
		expect((state.fields[WATCH_B] as { calculate?: string })?.calculate).toBe(
			"/data/notes = 'yes'",
		);
	});

	it("skips a move whose destination CONTAINER lives in another form", () => {
		// grp { a, b(calc /data/grp/a) } in form A; destination is form B's
		// group `sec`. The skip must resolve the container's containing form,
		// not just compare against form uuids.
		const SEC = asUuid("sec-0000-0000-0000-000000000000");
		const SUB_A = asUuid("sba-0000-0000-0000-000000000000");
		const SUB_B = asUuid("sbb-0000-0000-0000-000000000000");
		const doc = crossFormFixture();
		doc.fields[GRP] = {
			uuid: GRP,
			id: "grp",
			kind: "group",
			label: "Grp",
		} as BlueprintDoc["fields"][typeof GRP];
		doc.fields[SUB_A] = {
			uuid: SUB_A,
			id: "a",
			kind: "text",
			label: "A",
		} as BlueprintDoc["fields"][typeof SUB_A];
		doc.fields[SUB_B] = {
			uuid: SUB_B,
			id: "b",
			kind: "hidden",
			calculate: "/data/grp/a + 1",
		} as BlueprintDoc["fields"][typeof SUB_B];
		doc.fields[SEC] = {
			uuid: SEC,
			id: "sec",
			kind: "group",
			label: "Sec",
		} as BlueprintDoc["fields"][typeof SEC];
		doc.fieldOrder[FORM] = [NOTES_A, WATCH_A, GRP];
		doc.fieldOrder[GRP] = [SUB_A, SUB_B];
		doc.fieldOrder[FORM_B] = [NOTES_B, WATCH_B, SEC];
		doc.fieldOrder[SEC] = [];

		const store = createBlueprintDocStore();
		store.getState().load(doc);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const [result] = store
			.getState()
			.applyMany([
				{ kind: "moveField", uuid: GRP, toParentUuid: SEC, toIndex: 0 },
			]);

		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		expect(result).toBeUndefined();
		const state = store.getState();
		expect(state.fieldOrder[FORM]).toEqual([NOTES_A, WATCH_A, GRP]);
		expect(state.fieldOrder[SEC]).toEqual([]);
		expect((state.fields[SUB_B] as { calculate?: string })?.calculate).toBe(
			"/data/grp/a + 1",
		);
	});

	it("skips a move whose destination container is reachable from NO form (fail closed)", () => {
		// An orphaned group (present in `fields`, absent from every
		// `fieldOrder`) can arrive via a degenerate historical replay. The
		// guard must skip unless the move is PROVABLY same-form — proceeding
		// would teleport the field out of its form with zero reference
		// rewriting, the exact dangling-then-captured bug class the skip
		// exists to eliminate.
		const ORPHAN = asUuid("orp-0000-0000-0000-000000000000");
		const doc = fixture();
		doc.fields[ORPHAN] = {
			uuid: ORPHAN,
			id: "orphan",
			kind: "group",
			label: "Orphan",
		} as BlueprintDoc["fields"][typeof ORPHAN];

		const store = createBlueprintDocStore();
		store.getState().load(doc);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const [result] = store
			.getState()
			.applyMany([
				{ kind: "moveField", uuid: SRC, toParentUuid: ORPHAN, toIndex: 0 },
			]);

		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
		expect(result).toBeUndefined();
		const state = store.getState();
		expect(state.fieldOrder[GRP1]).toEqual([SRC]);
		expect(state.fieldOrder[ORPHAN]).toBeUndefined();
		expect((state.fields[REF] as { calculate?: string })?.calculate).toBe(
			"/data/grp1/source + 1",
		);
	});
});
