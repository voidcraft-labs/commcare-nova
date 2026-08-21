import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	flattenFieldRefs,
	getCrossLevelFieldMoveTargets,
	getFieldMoveTargets,
} from "@/lib/doc/navigation";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";

/**
 * Build a minimal `BlueprintDoc` from a flat list of field descriptors.
 *
 * The primitives under test read `fields`, `fieldOrder`, `fieldParent`,
 * and `forms` only. Everything else is supplied as placeholder so the
 * tests stay focused on the navigation logic rather than entity shape.
 *
 * Each descriptor is `{ uuid, id, kind, parentUuid, childrenOrder? }`.
 * `childrenOrder` present → the field is a container and gets a
 * `fieldOrder` entry (even when empty, matching the real invariant).
 */
interface FieldDesc {
	uuid: Uuid;
	id: string;
	kind: string;
	parentUuid: Uuid;
	childrenOrder?: Uuid[];
}

function buildDoc(formUuid: Uuid, descs: FieldDesc[]): BlueprintDoc {
	const fields: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const fieldParent: Record<Uuid, Uuid> = {};

	// Accumulate the form's root-level order separately from container orders.
	const rootOrder: Uuid[] = [];

	for (const d of descs) {
		// Cast to Field via the shared `unknown` bridge — the nav code
		// only reads `uuid`, `id`, and `kind`.
		fields[d.uuid] = {
			uuid: d.uuid,
			id: d.id,
			kind: d.kind,
		} as unknown as Field;
		fieldParent[d.uuid] = d.parentUuid;

		if (d.parentUuid === formUuid) {
			rootOrder.push(d.uuid);
		} else {
			const siblings = fieldOrder[d.parentUuid] ?? [];
			siblings.push(d.uuid);
			fieldOrder[d.parentUuid] = siblings;
		}

		if (d.childrenOrder !== undefined) {
			// Ensure the container has an order entry (possibly empty) so
			// the walker recurses into it. Entries for non-empty containers
			// are overwritten by the children loop above.
			fieldOrder[d.uuid] ??= [];
		}
	}
	fieldOrder[formUuid] = rootOrder;

	return {
		appId: "test-app",
		appName: "Nav Test",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "form",
				name: "Form",
				type: "survey",
			},
		},
		fields,
		moduleOrder: [],
		formOrder: {},
		fieldOrder,
		fieldParent,
	};
}

// ── Fixed UUIDs so test assertions are easy to read ───────────────────
const FORM = testUuid("form-uuid");
const Q1 = testUuid("q1-uuid");
const GRP = testUuid("grp-uuid");
const CHILD1 = testUuid("child1-uuid");
const CHILD2 = testUuid("child2-uuid");
const CHILD3 = testUuid("child3-uuid");
const Q2 = testUuid("q2-uuid");
const Q3 = testUuid("q3-uuid");

// A tree with a group in the middle and three children:
//   q1 (text)
//   grp (group)
//     child1 (text)
//     child2 (int)
//     child3 (text)
//   q2 (text)
//   q3 (date)
const flatTree = () =>
	buildDoc(FORM, [
		{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
		{
			uuid: GRP,
			id: "grp",
			kind: "group",
			parentUuid: FORM,
			childrenOrder: [],
		},
		{ uuid: CHILD1, id: "child1", kind: "text", parentUuid: GRP },
		{ uuid: CHILD2, id: "child2", kind: "int", parentUuid: GRP },
		{ uuid: CHILD3, id: "child3", kind: "text", parentUuid: GRP },
		{ uuid: Q2, id: "q2", kind: "text", parentUuid: FORM },
		{ uuid: Q3, id: "q3", kind: "date", parentUuid: FORM },
	]);

// A two-page form:
//   s1 (section)
//     p1a (text)
//     p1g (group)
//       p1g_child (text)
//   s2 (section)
//     p2a (text)
//     p2b (text)
const SEC1 = testUuid("sec1-uuid");
const SEC2 = testUuid("sec2-uuid");
const P1A = testUuid("p1a-uuid");
const P1G = testUuid("p1g-uuid");
const P1G_CHILD = testUuid("p1g-child-uuid");
const P2A = testUuid("p2a-uuid");
const P2B = testUuid("p2b-uuid");
const pagedTree = () =>
	buildDoc(FORM, [
		{
			uuid: SEC1,
			id: "s1",
			kind: "section",
			parentUuid: FORM,
			childrenOrder: [],
		},
		{ uuid: P1A, id: "p1a", kind: "text", parentUuid: SEC1 },
		{
			uuid: P1G,
			id: "p1g",
			kind: "group",
			parentUuid: SEC1,
			childrenOrder: [],
		},
		{ uuid: P1G_CHILD, id: "p1g_child", kind: "text", parentUuid: P1G },
		{
			uuid: SEC2,
			id: "s2",
			kind: "section",
			parentUuid: FORM,
			childrenOrder: [],
		},
		{ uuid: P2A, id: "p2a", kind: "text", parentUuid: SEC2 },
		{ uuid: P2B, id: "p2b", kind: "text", parentUuid: SEC2 },
	]);

describe("getCrossLevelFieldMoveTargets — sections", () => {
	it("never nests a section: a page has no cross-level targets", () => {
		const doc = pagedTree();
		expect(getCrossLevelFieldMoveTargets(doc, SEC1)).toEqual({
			up: undefined,
			down: undefined,
		});
		expect(getCrossLevelFieldMoveTargets(doc, SEC2)).toEqual({
			up: undefined,
			down: undefined,
		});
	});

	it("crosses a page boundary at a section's edges, never onto the form root", () => {
		const doc = pagedTree();
		// First child of the first page: nowhere up (no previous page);
		// down indents into the following group.
		const first = getCrossLevelFieldMoveTargets(doc, P1A);
		expect(first.up).toBeUndefined();
		expect(first.down).toEqual({
			toParentUuid: P1G,
			beforeUuid: P1G_CHILD,
			direction: "into",
		});
		// Last child of the first page: down goes to the START of page two.
		const last = getCrossLevelFieldMoveTargets(doc, P1G);
		expect(last.down).toEqual({
			toParentUuid: SEC2,
			beforeUuid: P2A,
			direction: "out-to-next-section",
		});
		// First child of page two: up goes to the END of page one.
		const p2 = getCrossLevelFieldMoveTargets(doc, P2A);
		expect(p2.up).toEqual({
			toParentUuid: SEC1,
			direction: "out-to-previous-section",
		});
		// Last child of the last page: nowhere down.
		expect(getCrossLevelFieldMoveTargets(doc, P2B).down).toBeUndefined();
	});

	it("keeps ordinary outdent inside a group that sits on a page", () => {
		const doc = pagedTree();
		const child = getCrossLevelFieldMoveTargets(doc, P1G_CHILD);
		expect(child.up).toEqual({
			toParentUuid: SEC1,
			beforeUuid: P1G,
			direction: "out",
		});
		expect(child.down).toEqual({
			toParentUuid: SEC1,
			afterUuid: P1G,
			direction: "out",
		});
	});
});

describe("flattenFieldRefs", () => {
	it("returns fields in visual (depth-first) render order", () => {
		const doc = flatTree();
		const uuids = flattenFieldRefs(doc, FORM).map((r) => r.uuid);
		expect(uuids).toEqual([Q1, GRP, CHILD1, CHILD2, CHILD3, Q2, Q3]);
	});

	it("skips hidden fields", () => {
		const HID = testUuid("hidden-uuid");
		const doc = buildDoc(FORM, [
			{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
			{ uuid: HID, id: "h1", kind: "hidden", parentUuid: FORM },
			{ uuid: Q2, id: "q2", kind: "text", parentUuid: FORM },
		]);
		const uuids = flattenFieldRefs(doc, FORM).map((r) => r.uuid);
		expect(uuids).toEqual([Q1, Q2]);
	});

	it("returns empty array for unknown form uuid", () => {
		const doc = flatTree();
		expect(flattenFieldRefs(doc, testUuid("missing"))).toEqual([]);
	});

	it("carries the correct parent uuid for each entry", () => {
		const doc = flatTree();
		const refs = flattenFieldRefs(doc, FORM);
		const byUuid = new Map(refs.map((r) => [r.uuid, r.parentUuid]));
		expect(byUuid.get(Q1)).toBe(FORM);
		expect(byUuid.get(GRP)).toBe(FORM);
		expect(byUuid.get(CHILD1)).toBe(GRP);
		expect(byUuid.get(CHILD2)).toBe(GRP);
	});
});

/**
 * The keyboard-navigation surface walks the membership array, which IS the
 * sequence: Tab/Shift-Tab and the delete-neighbour / arrow targets have to land
 * on the field the author sees next, at every nesting level.
 */
describe("navigation follows the sequence at every level", () => {
	const reorderedRoot = () =>
		buildDoc(FORM, [
			{ uuid: Q3, id: "q3", kind: "text", parentUuid: FORM },
			{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
			{ uuid: Q2, id: "q2", kind: "text", parentUuid: FORM },
		]);

	it("flattenFieldRefs walks the form's sequence", () => {
		const uuids = flattenFieldRefs(reorderedRoot(), FORM).map((r) => r.uuid);
		expect(uuids).toEqual([Q3, Q1, Q2]);
	});

	it("recurses into a container's children in their own sequence", () => {
		const doc = buildDoc(FORM, [
			{
				uuid: GRP,
				id: "grp",
				kind: "group",
				parentUuid: FORM,
				childrenOrder: [],
			},
			{ uuid: CHILD2, id: "c2", kind: "text", parentUuid: GRP },
			{ uuid: CHILD3, id: "c3", kind: "text", parentUuid: GRP },
			{ uuid: CHILD1, id: "c1", kind: "text", parentUuid: GRP },
		]);
		const uuids = flattenFieldRefs(doc, FORM).map((r) => r.uuid);
		expect(uuids).toEqual([GRP, CHILD2, CHILD3, CHILD1]);
	});

	it("getFieldMoveTargets returns the adjacent siblings", () => {
		expect(getFieldMoveTargets(reorderedRoot(), Q1)).toEqual({
			beforeUuid: Q3,
			afterUuid: Q2,
		});
		// The first field has no predecessor.
		expect(getFieldMoveTargets(reorderedRoot(), Q3)).toEqual({
			beforeUuid: undefined,
			afterUuid: Q1,
		});
	});

	it("getCrossLevelFieldMoveTargets indents into the previous container", () => {
		// Shift+Up on Q1 indents into GRP, the sibling above it.
		const doc = buildDoc(FORM, [
			{
				uuid: GRP,
				id: "grp",
				kind: "group",
				parentUuid: FORM,
				childrenOrder: [],
			},
			{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
		]);
		const { up } = getCrossLevelFieldMoveTargets(doc, Q1);
		expect(up).toEqual({ toParentUuid: GRP, direction: "into" });
	});
});

describe("getFieldMoveTargets", () => {
	it("returns previous/next sibling uuids for root-level fields", () => {
		const doc = flatTree();
		expect(getFieldMoveTargets(doc, Q2)).toEqual({
			beforeUuid: GRP,
			afterUuid: Q3,
		});
	});

	it("returns undefined beforeUuid for first root field", () => {
		const doc = flatTree();
		expect(getFieldMoveTargets(doc, Q1)).toEqual({
			beforeUuid: undefined,
			afterUuid: GRP,
		});
	});

	it("returns undefined afterUuid for last root field", () => {
		const doc = flatTree();
		expect(getFieldMoveTargets(doc, Q3)).toEqual({
			beforeUuid: Q2,
			afterUuid: undefined,
		});
	});

	it("operates at the sibling level inside a container (not depth-first)", () => {
		const doc = flatTree();
		expect(getFieldMoveTargets(doc, CHILD1)).toEqual({
			beforeUuid: undefined,
			afterUuid: CHILD2,
		});
	});

	it("returns both undefined for unknown uuid", () => {
		const doc = flatTree();
		expect(getFieldMoveTargets(doc, testUuid("nope"))).toEqual({
			beforeUuid: undefined,
			afterUuid: undefined,
		});
	});
});

describe("getCrossLevelFieldMoveTargets", () => {
	it("outdents up when the field is first child of a container", () => {
		const doc = flatTree();
		const { up } = getCrossLevelFieldMoveTargets(doc, CHILD1);
		expect(up).toEqual({
			toParentUuid: FORM,
			beforeUuid: GRP,
			direction: "out",
		});
	});

	it("outdents down when the field is last child of a container", () => {
		const doc = flatTree();
		const { down } = getCrossLevelFieldMoveTargets(doc, CHILD3);
		expect(down).toEqual({
			toParentUuid: FORM,
			afterUuid: GRP,
			direction: "out",
		});
	});

	it("indents up when the previous sibling is a container", () => {
		const doc = flatTree();
		const { up } = getCrossLevelFieldMoveTargets(doc, Q2);
		expect(up).toEqual({
			toParentUuid: GRP,
			direction: "into",
		});
	});

	it("indents down into the next container, landing before the first child", () => {
		const doc = flatTree();
		const { down } = getCrossLevelFieldMoveTargets(doc, Q1);
		expect(down).toEqual({
			toParentUuid: GRP,
			beforeUuid: CHILD1,
			direction: "into",
		});
	});

	it("indents down into an empty container without a beforeUuid", () => {
		// Edge case: empty container as next sibling → append by omitting beforeUuid.
		const EMPTY = testUuid("empty-grp-uuid");
		const doc = buildDoc(FORM, [
			{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
			{
				uuid: EMPTY,
				id: "empty",
				kind: "group",
				parentUuid: FORM,
				childrenOrder: [],
			},
		]);
		const { down } = getCrossLevelFieldMoveTargets(doc, Q1);
		expect(down).toEqual({
			toParentUuid: EMPTY,
			direction: "into",
		});
	});

	it("returns undefined when no adjacent container is available at the form root", () => {
		const doc = flatTree();
		const { up, down } = getCrossLevelFieldMoveTargets(doc, Q3);
		expect(up).toBeUndefined();
		expect(down).toBeUndefined();
	});

	it("returns undefined for mid-container fields with no cross-level target", () => {
		const doc = flatTree();
		const { up, down } = getCrossLevelFieldMoveTargets(doc, CHILD2);
		expect(up).toBeUndefined();
		expect(down).toBeUndefined();
	});

	it("outdents from a deeply-nested container into its immediate parent", () => {
		// outer -> before, inner (repeat) -> deep
		const OUTER = testUuid("outer-uuid");
		const BEFORE = testUuid("before-uuid");
		const INNER = testUuid("inner-uuid");
		const DEEP = testUuid("deep-uuid");
		const doc = buildDoc(FORM, [
			{
				uuid: OUTER,
				id: "outer",
				kind: "group",
				parentUuid: FORM,
				childrenOrder: [],
			},
			{ uuid: BEFORE, id: "before", kind: "text", parentUuid: OUTER },
			{
				uuid: INNER,
				id: "inner",
				kind: "repeat",
				parentUuid: OUTER,
				childrenOrder: [],
			},
			{ uuid: DEEP, id: "deep", kind: "text", parentUuid: INNER },
		]);
		const { up } = getCrossLevelFieldMoveTargets(doc, DEEP);
		expect(up).toEqual({
			toParentUuid: OUTER,
			beforeUuid: INNER,
			direction: "out",
		});
	});

	it("treats repeat containers identically to groups for indent", () => {
		const REP = testUuid("rep-uuid");
		const R1 = testUuid("r1-uuid");
		const doc = buildDoc(FORM, [
			{ uuid: Q1, id: "q1", kind: "text", parentUuid: FORM },
			{
				uuid: REP,
				id: "rep",
				kind: "repeat",
				parentUuid: FORM,
				childrenOrder: [],
			},
			{ uuid: R1, id: "r1", kind: "text", parentUuid: REP },
		]);
		const { down } = getCrossLevelFieldMoveTargets(doc, Q1);
		expect(down).toEqual({
			toParentUuid: REP,
			beforeUuid: R1,
			direction: "into",
		});
	});
});
