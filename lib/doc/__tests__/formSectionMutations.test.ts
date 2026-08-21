/**
 * The section planners: every gesture is a desired partition of the form's
 * top-level questions into pages, and every `ok` plan is replayed through the
 * reducers AND the commit gate, so a planner cannot promise a shape the
 * validator refuses. Plans are minimal (a kept field emits no move),
 * re-anchored at the landing (replaying the same batch reaches the same
 * document), and refused in one sentence when the partition is not one.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	addSection,
	currentPartition,
	type FormSectionPlan,
	mergeWithPrevious,
	removeSectionKeepingQuestions,
	setFormSections,
	splitIntoSections,
	splitSection,
} from "@/lib/doc/formSectionMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const FORM = testUuid("frm-1");
const A = testUuid("fld-a");
const B = testUuid("fld-b");
const C = testUuid("fld-c");
const D = testUuid("fld-d");
const G = testUuid("fld-g");
const G_CHILD = testUuid("fld-g-child");
const R = testUuid("fld-r");
const S1 = testUuid("sec-1");
const S2 = testUuid("sec-2");
const S3 = testUuid("sec-3");
const NEW = testUuid("sec-new");
const NEW2 = testUuid("sec-new-2");

function text(uuid: Uuid, id: string): FieldSpec {
	return f({ kind: "text", uuid, id, label: proseText(id) });
}

function docWith(fields: FieldSpec[]): BlueprintDoc {
	return buildDoc({
		appName: "Sections",
		modules: [
			{
				name: "Visits",
				forms: [{ uuid: FORM, name: "Visit", type: "survey", fields }],
			},
		],
	});
}

/** Single page: a, b, group g(g_child), c. */
function flat(): BlueprintDoc {
	return docWith([
		text(A, "a"),
		text(B, "b"),
		f({
			kind: "group",
			uuid: G,
			id: "g",
			label: proseText("G"),
			children: [text(G_CHILD, "inner")],
		}),
		text(C, "c"),
	]);
}

/** Two pages: [s1: a, b] [s2: c, d]. */
function paged(): BlueprintDoc {
	return docWith([
		f({
			kind: "section",
			uuid: S1,
			id: "s1",
			label: proseText("First"),
			children: [text(A, "a"), text(B, "b")],
		}),
		f({
			kind: "section",
			uuid: S2,
			id: "s2",
			children: [text(C, "c"), text(D, "d")],
		}),
	]);
}

function apply(doc: BlueprintDoc, plan: FormSectionPlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
	const verdict = mutationCommitVerdict(
		doc,
		plan.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`gate refused: ${verdict.findings.map((e) => e.message).join(" | ")}`,
		);
	}
	// Replay idempotence: the same batch on the committed doc is a no-op.
	const replayed = produce(verdict.nextDoc, (draft) => {
		applyMutations(draft, [...plan.mutations]);
	});
	expect(shape(replayed)).toEqual(shape(verdict.nextDoc));
	return verdict.nextDoc;
}

/** The root and every root section's children, by id, for readable asserts. */
function shape(doc: BlueprintDoc): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	const ids = (uuids: readonly Uuid[]) =>
		uuids.map((u) => doc.fields[u]?.id ?? "?");
	out.root = ids(doc.fieldOrder[FORM] ?? []);
	for (const uuid of doc.fieldOrder[FORM] ?? []) {
		const field = doc.fields[uuid];
		if (field?.kind === "section")
			out[field.id] = ids(doc.fieldOrder[uuid] ?? []);
	}
	return out;
}

function refusal(plan: FormSectionPlan): string {
	if (plan.ok) throw new Error("expected a refusal");
	return plan.reason;
}

describe("splitIntoSections", () => {
	it("puts everything before the cut on page one and the rest on page two", () => {
		const doc = flat();
		const plan = splitIntoSections(doc, FORM, {
			atFieldUuid: G,
			titles: [proseText("About you"), proseText("Details")],
			sectionUuids: [S1, S2],
		});
		const next = apply(doc, plan);
		expect(shape(next)).toEqual({
			root: ["about_you", "details"],
			about_you: ["a", "b"],
			details: ["g", "c"],
		});
		expect(plan.ok && plan.sectionUuids).toEqual([S1, S2]);
		// The group moved with its child.
		expect(next.fieldOrder[G]).toEqual([G_CHILD]);
	});

	it("makes one page of everything without a cut, and names it section_1 untitled", () => {
		const doc = flat();
		const next = apply(doc, splitIntoSections(doc, FORM));
		expect(shape(next)).toEqual({
			root: ["section_1"],
			section_1: ["a", "b", "g", "c"],
		});
		const section = Object.values(next.fields).find(
			(x) => x.kind === "section",
		);
		expect(section?.kind === "section" && section.label).toBeUndefined();
	});

	it("refuses an empty form: pages come from questions", () => {
		const doc = docWith([]);
		expect(
			refusal(splitIntoSections(doc, FORM, { sectionUuids: [S1] })),
		).toContain("nothing to split");
	});

	it("refuses a sectioned form and a cut that isn't a top-level field", () => {
		expect(refusal(splitIntoSections(paged(), FORM))).toContain(
			"already split into sections",
		);
		expect(
			refusal(splitIntoSections(flat(), FORM, { atFieldUuid: G_CHILD })),
		).toContain("isn't a top-level field");
	});

	it("refuses when a page would hold an add-entries repeat", () => {
		const doc = docWith([
			text(A, "a"),
			f({
				kind: "repeat",
				uuid: R,
				id: "visits",
				label: proseText("Visits"),
				repeat_mode: "user_controlled",
				children: [text(B, "b")],
			}),
		]);
		expect(refusal(splitIntoSections(doc, FORM))).toContain(
			"can't add repeat entries",
		);
	});

	it("slugs the title into the id and falls back when the slug is not a legal id", () => {
		const doc = flat();
		const next = apply(
			doc,
			splitIntoSections(doc, FORM, {
				atFieldUuid: B,
				titles: [proseText("1st things"), proseText("Your Details!")],
			}),
		);
		expect(shape(next).root).toEqual(["section_1", "your_details"]);
	});
});

describe("splitSection / addSection / mergeWithPrevious", () => {
	it("splits a page before a field, moving it and what follows to a new page after it", () => {
		const doc = paged();
		const next = apply(
			doc,
			splitSection(doc, S1, B, {
				title: proseText("Second"),
				sectionUuid: NEW,
			}),
		);
		expect(shape(next)).toEqual({
			root: ["s1", "second", "s2"],
			s1: ["a"],
			second: ["b"],
			s2: ["c", "d"],
		});
	});

	it("adds an empty page first, after a page, or last", () => {
		const doc = paged();
		expect(
			shape(
				apply(doc, addSection(doc, FORM, { after: null, sectionUuid: NEW })),
			).root,
		).toEqual(["section_1", "s1", "s2"]);
		expect(
			shape(apply(doc, addSection(doc, FORM, { after: S1, sectionUuid: NEW })))
				.root,
		).toEqual(["s1", "section_2", "s2"]);
		expect(
			shape(apply(doc, addSection(doc, FORM, { sectionUuid: NEW }))).root,
		).toEqual(["s1", "s2", "section_3"]);
	});

	it("refuses to add a page to a single-page or empty form", () => {
		expect(refusal(addSection(flat(), FORM))).toContain(
			"isn't split into sections yet",
		);
		// An empty form refuses too: a form of empty pages can't be built.
		const empty = docWith([]);
		expect(refusal(addSection(empty, FORM, { sectionUuid: NEW }))).toContain(
			"no questions yet",
		);
	});

	it("refuses a merge that would land two questions with one id on a page", () => {
		const doc = docWith([
			f({
				kind: "section",
				uuid: S1,
				id: "s1",
				children: [
					f({ kind: "text", uuid: A, id: "notes", label: proseText("Notes") }),
				],
			}),
			f({
				kind: "section",
				uuid: S2,
				id: "s2",
				children: [
					f({ kind: "text", uuid: C, id: "notes", label: proseText("Notes") }),
				],
			}),
		]);
		const reason = refusal(mergeWithPrevious(doc, S2));
		expect(reason).toContain('named "notes"');
		expect(reason).toContain("Rename one");
	});

	it("keeps a new page's title slug when its only clash is a question the plan moves onto it", () => {
		const doc = docWith([
			f({ kind: "text", uuid: A, id: "name", label: proseText("Name") }),
			text(B, "b"),
		]);
		const next = apply(
			doc,
			splitIntoSections(doc, FORM, {
				titles: [proseText("Name")],
				sectionUuids: [S1],
			}),
		);
		expect(next.fields[S1]?.id).toBe("name");
	});

	it("merges a page into the one before it and refuses on the first page", () => {
		const doc = paged();
		expect(shape(apply(doc, mergeWithPrevious(doc, S2)))).toEqual({
			root: ["s1"],
			s1: ["a", "b", "c", "d"],
		});
		expect(refusal(mergeWithPrevious(doc, S1))).toContain("first section");
	});
});

describe("removeSectionKeepingQuestions", () => {
	it("hands a removed page's questions to the previous page, or the next for the first", () => {
		const doc = paged();
		expect(shape(apply(doc, removeSectionKeepingQuestions(doc, S2)))).toEqual({
			root: ["s1"],
			s1: ["a", "b", "c", "d"],
		});
		expect(shape(apply(doc, removeSectionKeepingQuestions(doc, S1)))).toEqual({
			root: ["s2"],
			s2: ["a", "b", "c", "d"],
		});
	});

	it("returns the form to a single page when the last page goes", () => {
		const doc = paged();
		const one = apply(doc, mergeWithPrevious(doc, S2));
		const plan = removeSectionKeepingQuestions(one, S1);
		const next = apply(one, plan);
		expect(shape(next)).toEqual({ root: ["a", "b", "c", "d"] });
		expect(plan.ok && plan.sectionUuids).toEqual([]);
	});
});

describe("setFormSections", () => {
	it("keeps named pages, creates unnamed ones, removes the rest, and re-homes every question", () => {
		const doc = paged();
		const plan = setFormSections(doc, FORM, [
			{ sectionUuid: S2, label: proseText("Now first"), fields: [D] },
			{ sectionUuid: NEW, fields: [C, A] },
			{ fields: [B] },
		]);
		const next = apply(doc, plan);
		expect(shape(next)).toEqual({
			root: ["s2", "section_2", "section_3"],
			s2: ["d"],
			section_2: ["c", "a"],
			section_3: ["b"],
		});
		expect(next.fields[S1]).toBeUndefined();
		const kept = next.fields[S2];
		expect(kept?.kind === "section" && kept.label).toEqual(
			proseText("Now first"),
		);
		expect(plan.ok && plan.sectionUuids).toHaveLength(3);
		expect(plan.ok && plan.sectionUuids[0]).toBe(S2);
		expect(plan.ok && plan.sectionUuids[1]).toBe(NEW);
	});

	it("is minimal: re-stating the current partition emits nothing", () => {
		const doc = paged();
		const plan = setFormSections(doc, FORM, currentPartition(doc, FORM));
		expect(plan.ok && plan.mutations).toEqual([]);
		const retitle = setFormSections(doc, FORM, [
			{ sectionUuid: S1, label: null, fields: [A, B] },
			{ sectionUuid: S2, fields: [C, D] },
		]);
		expect(retitle.ok && retitle.mutations).toEqual([
			{
				kind: "updateField",
				uuid: S1,
				targetKind: "section",
				patch: { label: null },
			},
		]);
		const cleared = apply(doc, retitle);
		const s1 = cleared.fields[S1];
		expect(s1?.kind === "section" && s1.label).toBeUndefined();
	});

	it("pages a single-page form and un-pages a sectioned one", () => {
		const flatDoc = flat();
		const pagedNext = apply(
			flatDoc,
			setFormSections(flatDoc, FORM, [
				{ sectionUuid: NEW, label: proseText("One"), fields: [A, G] },
				{ sectionUuid: NEW2, fields: [B, C] },
			]),
		);
		expect(shape(pagedNext)).toEqual({
			root: ["one", "section_2"],
			one: ["a", "g"],
			section_2: ["b", "c"],
		});
		const pagedDoc = paged();
		const plan = setFormSections(pagedDoc, FORM, []);
		expect(shape(apply(pagedDoc, plan))).toEqual({
			root: ["a", "b", "c", "d"],
		});
		expect(plan.ok && plan.sectionUuids).toEqual([]);
		// Un-paging a single-page form is a no-op, not a refusal.
		const noop = setFormSections(flatDoc, FORM, []);
		expect(noop.ok && noop.mutations).toEqual([]);
	});

	it("refuses a partition that misses, repeats, or misnames a question", () => {
		const doc = paged();
		expect(
			refusal(
				setFormSections(doc, FORM, [{ sectionUuid: S1, fields: [A, B, C] }]),
			),
		).toMatch(/This one isn't in any section: "d"/);
		expect(
			refusal(
				setFormSections(doc, FORM, [
					{ sectionUuid: S1, fields: [A, B] },
					{ sectionUuid: S2, fields: [C, D, A] },
				]),
			),
		).toMatch(/"a" .* appears in two sections \("First" and section 2\)/);
		expect(
			refusal(
				setFormSections(doc, FORM, [
					{ sectionUuid: S1, fields: [A, B, C, D, S2] },
				]),
			),
		).toContain("is a section of");
		const withGroup = flat();
		expect(
			refusal(
				setFormSections(withGroup, FORM, [{ fields: [A, B, G, G_CHILD, C] }]),
			),
		).toMatch(/sits inside the group "g" and moves with it/);
		expect(
			refusal(
				setFormSections(doc, FORM, [
					{ fields: [A, B, C, D, testUuid("nope")] },
				]),
			),
		).toContain("isn't a question of");
	});

	it("refuses a foreign or repeated section uuid and an add-entries repeat on a page", () => {
		const doc = paged();
		expect(
			refusal(
				setFormSections(doc, FORM, [{ sectionUuid: A, fields: [A, B, C, D] }]),
			),
		).toContain("isn't a section of");
		expect(
			refusal(
				setFormSections(doc, FORM, [
					{ sectionUuid: S1, fields: [A, B] },
					{ sectionUuid: S1, fields: [C, D] },
				]),
			),
		).toContain("listed twice");
		const withRepeat = docWith([
			text(A, "a"),
			f({
				kind: "repeat",
				uuid: R,
				id: "visits",
				label: proseText("Visits"),
				repeat_mode: "user_controlled",
				children: [text(B, "b")],
			}),
		]);
		expect(
			refusal(setFormSections(withRepeat, FORM, [{ fields: [A, R] }])),
		).toContain("can't add repeat entries");
	});

	it("lets a bound repeat and a group with its children sit on a page", () => {
		const doc = docWith([
			text(A, "a"),
			f({
				kind: "repeat",
				uuid: R,
				id: "rows",
				label: proseText("Rows"),
				repeat_mode: "count_bound",
				repeat_count: xp("2"),
				children: [text(B, "b")],
			}),
		]);
		const next = apply(
			doc,
			setFormSections(doc, FORM, [{ sectionUuid: S1, fields: [R, A] }]),
		);
		expect(shape(next)).toEqual({
			root: ["section_1"],
			section_1: ["rows", "a"],
		});
	});
});

describe("predeclared section uuids", () => {
	it("creates a page under a fresh uuid the caller names, keeping the rest", () => {
		const doc = paged();
		const plan = setFormSections(doc, FORM, [
			{ sectionUuid: S1, fields: [A, B] },
			{ sectionUuid: S3, label: proseText("Third"), fields: [C, D] },
		]);
		const next = apply(doc, plan);
		expect(shape(next)).toEqual({
			root: ["s1", "third"],
			s1: ["a", "b"],
			third: ["c", "d"],
		});
		expect(next.fields[S3]?.kind).toBe("section");
		expect(next.fields[S2]).toBeUndefined();
		expect(plan.ok && plan.sectionUuids).toEqual([S1, S3]);
	});
});
