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
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
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
	const plan = item.plan(doc);
	expect(plan.ok).toBe(true);
	if (!plan.ok) return;
	const verdict = mutationCommitVerdict(
		doc,
		plan.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(true);
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
		expectCommits(doc, gestures.items[0] as SectionGestureItem);
	});

	it("offers the kinds plus a split on a sectionless root", () => {
		const doc = flat();
		const middle = sectionGestureItems(doc, FORM, 1);
		expect(middle.offersKinds).toBe(true);
		expect(middle.insertLabel).toBe("Insert field");
		expect(middle.items.map((i) => i.label)).toEqual([
			"Split into sections here",
		]);
		expectCommits(doc, middle.items[0] as SectionGestureItem);

		const edge = sectionGestureItems(doc, FORM, 0);
		expect(edge.items.map((i) => i.label)).toEqual(["Split into sections"]);
		expectCommits(doc, edge.items[0] as SectionGestureItem);
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
		expectCommits(doc, between.items[0] as SectionGestureItem);

		const end = sectionGestureItems(doc, S1, 2);
		expect(end.items[0]).toMatchObject({
			key: "add-section",
			label: "New section after this one",
		});
		expectCommits(doc, end.items[0] as SectionGestureItem);
	});

	it("offers no page gesture inside a group", () => {
		const gestures = sectionGestureItems(flat(), G, 0);
		expect(gestures.context).toBe("nested");
		expect(gestures.offersKinds).toBe(true);
		expect(gestures.items).toEqual([]);
	});
});
