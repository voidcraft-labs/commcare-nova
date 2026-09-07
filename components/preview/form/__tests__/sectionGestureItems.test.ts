/**
 * What an insertion gap offers by context, and that every offered gesture
 * plans a batch the commit gate accepts (the picker never offers what the
 * gate refuses).
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { SectionGestureItem } from "@/components/preview/form/sectionGestureItems";
import {
	insertionContext,
	sectionGestureItems,
} from "@/components/preview/form/sectionGestureItems";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const FORM = testUuid("frm-visit");
const A = testUuid("fld-a");
const B = testUuid("fld-b");
const G = testUuid("fld-g");
const S1 = testUuid("sec-1");
const S2 = testUuid("sec-2");

const text = (uuid: string, id: string) =>
	f({ kind: "text", uuid, id, label: proseText(id) });

function docOf(fields: ReturnType<typeof f>[]): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				uuid: "mod-visits",
				name: "Visits",
				forms: [{ uuid: "frm-visit", name: "Visit", type: "survey", fields }],
			},
		],
	});
}

const flat = () =>
	docOf([
		text(A, "a"),
		f({
			kind: "group",
			uuid: G,
			id: "g",
			label: proseText("G"),
			children: [text(B, "b")],
		}),
	]);

const paged = () =>
	docOf([
		f({
			kind: "section",
			uuid: S1,
			id: "s1",
			label: proseText("First"),
			children: [text(A, "a"), text(B, "b")],
		}),
		f({ kind: "section", uuid: S2, id: "s2", children: [] }),
	]);

/** Every enabled gesture must plan a batch the gate commits. */
function expectCommits(doc: BlueprintDoc, item: SectionGestureItem) {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const plan = item.plan(doc);
	expect(plan.ok).toBe(true);
	if (!plan.ok) throw new Error(plan.reason);
	const verdict = mutationCommitVerdict(
		doc,
		plan.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
	return verdict.nextDoc;
}

describe("insertionContext", () => {
	it("tells the four contexts apart", () => {
		expect(insertionContext(flat(), FORM)).toBe("sectionless-root");
		expect(insertionContext(flat(), G)).toBe("nested");
		expect(insertionContext(paged(), FORM)).toBe("sectioned-root");
		expect(insertionContext(paged(), S1)).toBe("in-section");
	});
});

describe("sectionGestureItems", () => {
	it("offers only a new page on a sectioned root, named on the gap", () => {
		const doc = paged();
		const gestures = sectionGestureItems(doc, FORM, 1);
		expect(gestures.context).toBe("sectioned-root");
		expect(gestures.offersKinds).toBe(false);
		expect(gestures.insertLabel).toBe("Add a section");
		expect(gestures.items.map((i) => i.key)).toEqual(["add-section"]);
		const next = expectCommits(doc, gestures.items[0] as SectionGestureItem);
		expect(next.fieldOrder[FORM]).toHaveLength(3);
		expect(next.fieldOrder[FORM][0]).toBe(S1);
		expect(next.fieldOrder[FORM][2]).toBe(S2);
		expect(next.fieldOrder[next.fieldOrder[FORM][1]]).toEqual([]);
	});

	it("offers the kinds plus a split on a sectionless root", () => {
		const doc = flat();
		const middle = sectionGestureItems(doc, FORM, 1);
		expect(middle.offersKinds).toBe(true);
		expect(middle.insertLabel).toBe("Insert field");
		expect(middle.items.map((i) => i.label)).toEqual([
			"Split into sections here",
		]);
		const split = expectCommits(doc, middle.items[0] as SectionGestureItem);
		expect(
			split.fieldOrder[FORM].map((uuid) => split.fieldOrder[uuid]),
		).toEqual([[A], [G]]);
		expect(split.fieldOrder[G]).toEqual([B]);

		const edge = sectionGestureItems(doc, FORM, 0);
		expect(edge.items.map((i) => i.label)).toEqual(["Split into sections"]);
		const wrapped = expectCommits(doc, edge.items[0] as SectionGestureItem);
		expect(
			wrapped.fieldOrder[FORM].map((uuid) => wrapped.fieldOrder[uuid]),
		).toEqual([[A, G]]);
	});

	it("inside a page: split here, or a new page after the last question", () => {
		const doc = paged();
		const start = sectionGestureItems(doc, S1, 0);
		expect(start.items[0]).toMatchObject({
			key: "split-section",
			disabledReason: "Already the start of this section",
		});

		const between = sectionGestureItems(doc, S1, 1);
		expect(between.items[0]).toMatchObject({
			key: "split-section",
			label: "Split section here",
		});
		expect(between.items[0]?.disabledReason).toBeUndefined();
		const split = expectCommits(doc, between.items[0] as SectionGestureItem);
		expect(
			split.fieldOrder[FORM].map((uuid) => split.fieldOrder[uuid]),
		).toEqual([[A], [B], []]);

		const end = sectionGestureItems(doc, S1, 2);
		expect(end.items[0]).toMatchObject({
			key: "add-section",
			label: "New section after this one",
		});
		const added = expectCommits(doc, end.items[0] as SectionGestureItem);
		expect(
			added.fieldOrder[FORM].map((uuid) => added.fieldOrder[uuid]),
		).toEqual([[A, B], [], []]);
		expect(added.fieldOrder[FORM].at(-1)).toBe(S2);
	});

	it("offers no page gesture inside a group", () => {
		const gestures = sectionGestureItems(flat(), G, 0);
		expect(gestures.context).toBe("nested");
		expect(gestures.offersKinds).toBe(true);
		expect(gestures.items).toEqual([]);
	});
});
