/**
 * The four after-submit link mutations: reducers (total, idempotent,
 * anchor-driven), admission (sequence, target, identity), the commit gate,
 * the document diff, and the reference index.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationIdentityAdmissionIssue } from "@/lib/doc/mutationIdentityAdmission";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { referencingCarrierUuids } from "@/lib/doc/referenceIndex";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	casePropertyTargetKey,
	type FormLink,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const M0 = testUuid("mod-0");
const M1 = testUuid("mod-1");
const SOURCE = testUuid("frm-source");
const TARGET_A = testUuid("frm-a");
const TARGET_B = testUuid("frm-b");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const L3 = testUuid("lnk-3");

function fixture(): BlueprintDoc {
	return buildDoc({
		appName: "Links",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "status", label: proseText("Status") }],
			},
		],
		modules: [
			{
				uuid: "mod-0",
				name: "Intake",
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: "survey",
						postSubmit: "app_home",
						formLinks: [
							{
								uuid: "lnk-1",
								condition: "#user/username = 'a'",
								target: { type: "form", moduleUuid: M1, formUuid: TARGET_A },
							},
							{
								uuid: "lnk-2",
								target: { type: "module", moduleUuid: M1 },
							},
						],
						fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
					},
				],
			},
			{
				uuid: "mod-1",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-a",
						name: "A",
						type: "survey",
						fields: [f({ kind: "text", id: "a", label: proseText("A") })],
					},
					{
						uuid: "frm-b",
						name: "B",
						type: "survey",
						fields: [f({ kind: "text", id: "b", label: proseText("B") })],
					},
				],
			},
		],
	});
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

const linkOrder = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid);

const newLink = (): FormLink => ({
	uuid: L3,
	target: { type: "form", moduleUuid: M1, formUuid: TARGET_B },
});

describe("reducers", () => {
	it("addFormLink appends by default, inserts after an anchor, and lands first on null", () => {
		const doc = fixture();
		expect(
			linkOrder(
				apply(doc, [
					{ kind: "addFormLink", formUuid: SOURCE, link: newLink() },
				]),
			),
		).toEqual([L1, L2, L3]);
		expect(
			linkOrder(
				apply(doc, [
					{ kind: "addFormLink", formUuid: SOURCE, link: newLink(), after: L1 },
				]),
			),
		).toEqual([L1, L3, L2]);
		expect(
			linkOrder(
				apply(doc, [
					{
						kind: "addFormLink",
						formUuid: SOURCE,
						link: newLink(),
						after: null,
					},
				]),
			),
		).toEqual([L3, L1, L2]);
	});

	it("addFormLink is idempotent on the link uuid and never aliases the payload", () => {
		const doc = fixture();
		const link = newLink();
		const once = apply(doc, [{ kind: "addFormLink", formUuid: SOURCE, link }]);
		const twice = apply(once, [
			{ kind: "addFormLink", formUuid: SOURCE, link },
		]);
		expect(linkOrder(twice)).toEqual([L1, L2, L3]);
		expect(once.forms[SOURCE]?.formLinks?.[2]).not.toBe(link);
	});

	it("addFormLink creates the formLinks slot on a form without one", () => {
		const doc = fixture();
		const next = apply(doc, [
			{ kind: "addFormLink", formUuid: TARGET_A, link: newLink() },
		]);
		expect(next.forms[TARGET_A]?.formLinks?.map((l) => l.uuid)).toEqual([L3]);
	});

	it("updateFormLink patches key by key and clears on null", () => {
		const doc = fixture();
		const patched = apply(doc, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: {
					condition: null,
					datums: [{ name: "case_id", xpath: xp("'x'") }],
				},
			},
		]);
		const link = patched.forms[SOURCE]?.formLinks?.[0];
		expect(link?.condition).toBeUndefined();
		expect(link?.datums?.[0]?.name).toBe("case_id");
		expect(link?.target).toEqual({
			type: "form",
			moduleUuid: M1,
			formUuid: TARGET_A,
		});
		const cleared = apply(patched, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { datums: null },
			},
		]);
		expect(cleared.forms[SOURCE]?.formLinks?.[0]?.datums).toBeUndefined();
	});

	it("moveFormLink re-sequences by anchor and replays to the same order", () => {
		const doc = fixture();
		const move: Mutation = {
			kind: "moveFormLink",
			formUuid: SOURCE,
			uuid: L2,
			after: null,
		};
		const moved = apply(doc, [move]);
		expect(linkOrder(moved)).toEqual([L2, L1]);
		expect(linkOrder(apply(moved, [move]))).toEqual([L2, L1]);
	});

	it("removeFormLink drops the link and deletes the slot when it empties", () => {
		const doc = fixture();
		const one = apply(doc, [
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L1 },
		]);
		expect(linkOrder(one)).toEqual([L2]);
		const none = apply(one, [
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
		]);
		expect(none.forms[SOURCE]?.formLinks).toBeUndefined();
		expect("formLinks" in (none.forms[SOURCE] ?? {})).toBe(false);
	});

	it("a missing form or link is a no-op, never a throw", () => {
		const doc = fixture();
		const ghost = testUuid("ghost");
		const next = apply(doc, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: ghost,
				patch: { condition: null },
			},
			{ kind: "removeFormLink", formUuid: ghost, uuid: L1 },
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: ghost, after: null },
		]);
		expect(linkOrder(next)).toEqual([L1, L2]);
	});
});

describe("admission", () => {
	it("the schema admits the four kinds and refuses a payload under the wrong key", () => {
		expect(
			mutationSchema.safeParse({
				kind: "addFormLink",
				formUuid: SOURCE,
				link: newLink(),
			}).success,
		).toBe(true);
		expect(
			mutationSchema.safeParse({
				kind: "addFormLink",
				formUuid: SOURCE,
				value: newLink(),
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: {},
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "moveFormLink",
				formUuid: SOURCE,
				uuid: L1,
			}).success,
		).toBe(false);
	});

	it("a declared anchor that does not exist is a sequence issue", () => {
		const doc = fixture();
		const missing = testUuid("missing");
		expect(
			mutationSequenceAdmissionIssue(doc, [
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: newLink(),
					after: missing,
				},
			]),
		).toMatchObject({ anchor: missing });
		expect(
			mutationSequenceAdmissionIssue(doc, [
				{ kind: "moveFormLink", formUuid: SOURCE, uuid: L1, after: missing },
			]),
		).toMatchObject({ anchor: missing });
		expect(
			mutationSequenceAdmissionIssue(doc, [
				{ kind: "moveFormLink", formUuid: SOURCE, uuid: L1, after: L1 },
			]),
		).toBeDefined();
		expect(
			mutationSequenceAdmissionIssue(doc, [
				{ kind: "moveFormLink", formUuid: SOURCE, uuid: L1, after: L2 },
			]),
		).toBeUndefined();
	});

	it("an anchor born earlier in the same batch is admitted", () => {
		const doc = fixture();
		const fourth = testUuid("lnk-4");
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "addFormLink", formUuid: SOURCE, link: newLink() },
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: { uuid: fourth, target: { type: "module", moduleUuid: M0 } },
					after: L3,
				},
			]),
		).toBe(false);
	});

	it("a reused identity is refused, across forms and within one batch", () => {
		const doc = fixture();
		expect(
			mutationIdentityAdmissionIssue(doc, [
				{
					kind: "addFormLink",
					formUuid: TARGET_A,
					link: { ...newLink(), uuid: L1 },
				},
			]),
		).toBeDefined();
		expect(
			mutationIdentityAdmissionIssue(doc, [
				{ kind: "addFormLink", formUuid: SOURCE, link: newLink() },
				{ kind: "addFormLink", formUuid: TARGET_A, link: newLink() },
			]),
		).toBeDefined();
	});

	it("a link addressed on the wrong form, or gone, is an invalid target", () => {
		const doc = fixture();
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "updateFormLink",
					formUuid: TARGET_A,
					uuid: L1,
					patch: { condition: null },
				},
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: testUuid("ghost") },
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "moveFormLink", formUuid: TARGET_A, uuid: L1, after: null },
			]),
		).toBe(true);
		// Remove then address: the second mutation has no target.
		expect(
			mutationTargetsInvalid(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: L1 },
				{
					kind: "updateFormLink",
					formUuid: SOURCE,
					uuid: L1,
					patch: { condition: null },
				},
			]),
		).toBe(true);
	});

	it("the commit gate admits a valid add and refuses one that breaks a link rule", () => {
		const doc = fixture();
		expect(
			mutationCommitVerdict(
				doc,
				[
					{
						kind: "addFormLink",
						formUuid: TARGET_A,
						link: { uuid: L3, target: { type: "module", moduleUuid: M0 } },
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
		const verdict = mutationCommitVerdict(
			doc,
			// After the unconditional else: unreachable.
			[{ kind: "addFormLink", formUuid: SOURCE, link: newLink() }],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"FORM_LINK_UNREACHABLE",
			);
		}
	});
});

describe("document diff", () => {
	it("derives add / patch / move / remove and replays to the same links", () => {
		const prev = fixture();
		const next = produce(prev, (draft) => {
			const form = draft.forms[SOURCE];
			if (form?.formLinks === undefined) throw new Error("fixture");
			const [first, second] = form.formLinks;
			// Patch the conditional link, clear nothing, add a third, then
			// reorder so the else stays last.
			first.condition = xp("#user/username = 'b'");
			form.formLinks = [
				first,
				{
					uuid: L3,
					condition: xp("#user/username = 'c'"),
					target: { type: "form", moduleUuid: M1, formUuid: TARGET_B },
				},
				second,
			];
		});
		const mutations = diffDocsToMutations(prev, next);
		expect(mutations.map((m) => m.kind)).toEqual(
			expect.arrayContaining(["updateFormLink", "addFormLink"]),
		);
		expect(mutations.some((m) => m.kind === "updateForm")).toBe(false);
		const replayed = apply(prev, mutations);
		expect(replayed.forms[SOURCE]?.formLinks).toEqual(
			next.forms[SOURCE]?.formLinks,
		);

		const removed = produce(next, (draft) => {
			const form = draft.forms[SOURCE];
			if (form?.formLinks === undefined) throw new Error("fixture");
			form.formLinks = form.formLinks.filter((link) => link.uuid !== L3);
		});
		const removal = diffDocsToMutations(next, removed);
		expect(removal).toEqual([
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L3 },
		]);
	});

	it("a cleared condition travels as an explicit null", () => {
		const prev = fixture();
		const next = produce(prev, (draft) => {
			const link = draft.forms[SOURCE]?.formLinks?.[0];
			if (link === undefined) throw new Error("fixture");
			delete link.condition;
		});
		expect(diffDocsToMutations(prev, next)).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { condition: null },
			},
		]);
	});
});

describe("reference index", () => {
	it("a link condition's case reference is indexed under the form and follows every link mutation", () => {
		const doc = apply(fixture(), [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { condition: xp("#patient/status = 'open'") },
			},
		]);
		const key = casePropertyTargetKey("patient", "status");
		expect(referencingCarrierUuids(doc, key)).toContain(SOURCE);

		const cleared = apply(doc, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { condition: null },
			},
		]);
		expect(referencingCarrierUuids(cleared, key)).not.toContain(SOURCE);

		const readded = apply(cleared, [
			{
				kind: "addFormLink",
				formUuid: SOURCE,
				link: {
					uuid: L3,
					condition: xp("#patient/status = 'open'"),
					target: { type: "module", moduleUuid: M1 },
				},
				after: L1,
			},
		]);
		expect(referencingCarrierUuids(readded, key)).toContain(SOURCE);
		const removed = apply(readded, [
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L3 },
		]);
		expect(referencingCarrierUuids(removed, key)).not.toContain(SOURCE);
	});
});
