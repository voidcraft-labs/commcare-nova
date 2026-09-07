import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { fieldSlotAfter } from "@/lib/doc/fieldSlot";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, type Uuid } from "@/lib/domain";
import {
	makeDropEmptyContainerData,
	makeDropFieldData,
	makeDropGroupHeaderData,
	makeDropSectionHeaderData,
} from "../dragData";
import {
	createFormDragSession,
	type FormDropPlan,
	resolveFormDrop,
} from "../dragIntent";
import { buildFormRows } from "../rowModel";

const FORM = testUuid("drag-form");
const A = testUuid("drag-a");
const B = testUuid("drag-b");
const C = testUuid("drag-c");
const G = testUuid("drag-group");
const CHILD = testUuid("drag-child");
const EMPTY = testUuid("drag-empty");
const S1 = testUuid("drag-section-1");
const S2 = testUuid("drag-section-2");
const S3 = testUuid("drag-section-3");
const question = (uuid: Uuid, id: string) => f({ uuid, id, kind: "text" });

function fixture(paged = false) {
	const fields = paged
		? [
				f({
					uuid: S1,
					id: "first",
					kind: "section",
					children: [question(A, "a")],
				}),
				f({
					uuid: S2,
					id: "second",
					kind: "section",
					children: [question(B, "b")],
				}),
				f({
					uuid: S3,
					id: "third",
					kind: "section",
					children: [question(C, "c")],
				}),
			]
		: [
				question(A, "a"),
				question(B, "b"),
				question(C, "c"),
				f({
					uuid: G,
					id: "group",
					kind: "group",
					children: [question(CHILD, "child")],
				}),
				f({ uuid: EMPTY, id: "empty", kind: "group", children: [] }),
			];
	const doc = buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [{ uuid: FORM, name: "Visit", type: "survey", fields }],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const admission = mutationCommitVerdict(
		doc,
		[{ kind: "setAppName", name: "Drag fixture" }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(
		admission.ok,
		JSON.stringify(admission.ok ? [] : admission.findings),
	).toBe(true);
	return doc;
}

const rows = (doc: BlueprintDoc) =>
	buildFormRows(doc, FORM, {
		includeInsertionPoints: true,
		collapsed: new Set(),
	});

function commit(doc: BlueprintDoc, plan: FormDropPlan | null) {
	if (!plan) throw new Error("Expected a move");
	const { uuid, placement } = plan;
	const after = fieldSlotAfter(doc, placement.toParentUuid, placement, uuid);
	const result = mutationCommitVerdict(
		doc,
		[{ kind: "moveField", uuid, toParentUuid: placement.toParentUuid, after }],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(result.ok, JSON.stringify(result.ok ? [] : result.findings)).toBe(
		true,
	);
	return result.nextDoc;
}

function fieldTarget(uuid: Uuid, edge: "top" | "bottom", parent = FORM) {
	return { drop: makeDropFieldData(uuid, parent, 999), edge };
}

describe("form drag planning against the live document", () => {
	it.each(["top", "bottom"] as const)(
		"moves across siblings at the %s edge, with the preview gap matching the committed order",
		(edge) => {
			const doc = fixture();
			const plan = resolveFormDrop(doc, rows(doc), A, fieldTarget(C, edge));
			expect(plan).toMatchObject({
				placeholderIndex: edge === "top" ? 4 : 6,
				placeholderDepth: 0,
			});
			const next = commit(doc, plan);
			expect(next.fieldOrder[FORM]).toEqual(
				edge === "top" ? [B, A, C, G, EMPTY] : [B, C, A, G, EMPTY],
			);
		},
	);

	it("enters a group through its bottom edge and can leave it through its top edge", () => {
		const doc = fixture();
		const next = commit(
			doc,
			resolveFormDrop(doc, rows(doc), A, {
				drop: makeDropGroupHeaderData(G, FORM, 3),
				edge: "bottom",
			}),
		);
		expect(next.fieldOrder[G]).toEqual([A, CHILD]);
		expect(next.fieldParent[A]).toBe(G);
		const out = commit(
			next,
			resolveFormDrop(next, rows(next), A, {
				drop: makeDropGroupHeaderData(G, FORM, 3),
				edge: "top",
			}),
		);
		expect(out.fieldOrder[FORM]).toEqual([B, C, A, G, EMPTY]);
		expect(out.fieldOrder[G]).toEqual([CHILD]);
	});

	it("moves into an empty container, but refuses a descendant landing and adjacent or self drops", () => {
		const doc = fixture();
		const next = commit(
			doc,
			resolveFormDrop(doc, rows(doc), A, {
				drop: makeDropEmptyContainerData(EMPTY),
				edge: null,
			}),
		);
		expect(next.fieldOrder[EMPTY]).toEqual([A]);
		for (const target of [fieldTarget(B, "top"), fieldTarget(A, "bottom")]) {
			expect(resolveFormDrop(doc, rows(doc), A, target)).toBeNull();
		}
		expect(
			resolveFormDrop(doc, rows(doc), G, fieldTarget(CHILD, "bottom", G)),
		).toBeNull();
	});

	it("moves sections beside sections and questions into sections, never beside them", () => {
		const doc = fixture(true);
		const target = {
			drop: makeDropSectionHeaderData(S3, FORM, 2),
			edge: "bottom" as const,
		};
		const plan = resolveFormDrop(doc, rows(doc), S1, target);
		expect(rows(doc)[plan?.placeholderIndex ?? -1]).toMatchObject({
			kind: "insertion",
			parentUuid: FORM,
			beforeIndex: 3,
		});
		expect(commit(doc, plan).fieldOrder[FORM]).toEqual([S2, S3, S1]);
		const questionMove = commit(
			doc,
			resolveFormDrop(doc, rows(doc), A, target),
		);
		expect(questionMove.fieldOrder[S3]).toEqual([A, C]);
		expect(
			resolveFormDrop(doc, rows(doc), A, { ...target, edge: "top" }),
		).toBeNull();
	});
});

describe("form drag session lifetime", () => {
	function session() {
		let doc = fixture();
		let publications = 0;
		const state = createFormDragSession({
			getDoc: () => doc,
			getRows: () => rows(doc),
			onChange: () => {
				publications++;
			},
		});
		return {
			state,
			getDoc: () => doc,
			setDoc: (next: BlueprintDoc) => {
				doc = next;
			},
			publications: () => publications,
		};
	}

	it("keeps the displayed landing across an untargeted gap and retires it after drop", () => {
		const { state, getDoc, publications } = session();
		state.start(A);
		state.hover(fieldTarget(C, "bottom"));
		const before = publications();
		state.hover(fieldTarget(C, "bottom"));
		state.hover(null);
		expect(publications()).toBe(before);
		expect(commit(getDoc(), state.drop()).fieldOrder[FORM]).toEqual([
			B,
			C,
			A,
			G,
			EMPTY,
		]);
		expect(state.getSnapshot()).toEqual({
			dragActive: false,
			placeholderIndex: null,
			placeholderDepth: 0,
		});
		expect(state.drop()).toBeNull();
	});

	it("clears a previous landing when a later target is forbidden, and cancellation cannot move", () => {
		const { state } = session();
		state.start(G);
		state.hover(fieldTarget(A, "top"));
		expect(state.getSnapshot().placeholderIndex).toBe(0);
		state.hover(fieldTarget(CHILD, "bottom", G));
		expect(state.getSnapshot().placeholderIndex).toBeNull();
		expect(state.drop()).toBeNull();
		state.start(A);
		state.hover(fieldTarget(C, "bottom"));
		state.cancel();
		expect(state.drop()).toBeNull();
	});

	it("rechecks the target identity after a peer removes or reparents it", () => {
		for (const kind of ["remove", "reparent"] as const) {
			const { state, getDoc, setDoc } = session();
			state.start(A);
			state.hover(fieldTarget(C, "bottom"));
			const mutation =
				kind === "remove"
					? { kind: "removeField" as const, uuid: C }
					: {
							kind: "moveField" as const,
							uuid: C,
							toParentUuid: G,
							after: null,
						};
			const next = mutationCommitVerdict(
				getDoc(),
				[mutation],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(next.ok).toBe(true);
			setDoc(next.nextDoc);
			expect(state.drop()).toBeNull();
		}
	});

	it("updates the pending identity even when a peer edit leaves the same visible row index", () => {
		const { state, getDoc, setDoc } = session();
		state.start(G);
		state.hover(fieldTarget(B, "top"));
		const previousIndex = state.getSnapshot().placeholderIndex;
		const changed = mutationCommitVerdict(
			getDoc(),
			[{ kind: "moveField", uuid: C, toParentUuid: FORM, after: A }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(changed.ok).toBe(true);
		setDoc(changed.nextDoc);
		state.hover(fieldTarget(C, "top"));
		expect(state.getSnapshot().placeholderIndex).toBe(previousIndex);
		expect(commit(getDoc(), state.drop()).fieldOrder[FORM]).toEqual([
			A,
			G,
			C,
			B,
			EMPTY,
		]);
	});
});
