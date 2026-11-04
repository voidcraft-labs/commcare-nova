/**
 * The four after-submit link mutations and `setFormOtherwise`: reducers
 * (total, idempotent, anchor-driven), admission (sequence, target,
 * identity), the commit gate, the document diff, undo, and the reference
 * index.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { mutationIdentityAdmissionIssue } from "@/lib/doc/mutationIdentityAdmission";
import { mutationSequenceAdmissionIssue } from "@/lib/doc/mutationSequenceAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import {
	buildReferenceIndex,
	referencingCarrierUuids,
} from "@/lib/doc/referenceIndex";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	casePropertyTargetKey,
	entityTargetKey,
	type FormLink,
	type FormOtherwise,
} from "@/lib/domain";
import { eq, literal, sessionUser } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const M0 = testUuid("mod-0");
const M1 = testUuid("mod-1");
const SOURCE = testUuid("frm-source");
const TARGET_A = testUuid("frm-a");
const TARGET_B = testUuid("frm-b");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const L3 = testUuid("lnk-3");
const OTHERWISE = testUuid("lnk-otherwise");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
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
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: "followup",
						formLinks: [
							{
								uuid: "lnk-1",
								condition: eq(sessionUser("username"), literal("a")),
								target: { type: "form", moduleUuid: M1, formUuid: TARGET_A },
							},
							{
								uuid: "lnk-2",
								condition: eq(sessionUser("username"), literal("b")),
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
	assertAdmittedDoc(doc);
	return doc;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

const linkOrder = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid);

const newLink = (): FormLink => ({
	uuid: L3,
	condition: eq(sessionUser("username"), literal("c")),
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
		const twice = produce(once, (draft) => {
			applyMutations(draft, [{ kind: "addFormLink", formUuid: SOURCE, link }]);
		});
		expect(linkOrder(twice)).toEqual([L1, L2, L3]);
		expect(once.forms[SOURCE]?.formLinks?.[2]).not.toBe(link);
	});

	it("addFormLink creates the formLinks slot on a form without one", () => {
		const doc = fixture();
		const next = apply(doc, [
			{
				kind: "addFormLink",
				formUuid: TARGET_A,
				link: { uuid: L3, target: newLink().target },
			},
		]);
		expect(next.forms[TARGET_A]?.formLinks?.map((l) => l.uuid)).toEqual([L3]);
	});

	it("clears the terminal condition via JSON null while retaining its target", () => {
		const before = fixture();
		const next = apply(before, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L2,
				patch: { condition: null },
			},
		]);
		expect(next.forms[SOURCE]?.formLinks?.[1]).toEqual({
			uuid: L2,
			target: { type: "module", moduleUuid: M1 },
		});
		expect(next.forms[SOURCE]?.formLinks?.[0]).toEqual(
			before.forms[SOURCE]?.formLinks?.[0],
		);
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

	it("moveForm across modules carries every inbound form target with the form", () => {
		const doc = fixture();
		const moved = apply(doc, [
			{ kind: "moveForm", uuid: TARGET_A, toModuleUuid: M0, after: SOURCE },
		]);
		expect(moved.forms[SOURCE]?.formLinks?.[0]?.target).toEqual({
			type: "form",
			moduleUuid: M0,
			formUuid: TARGET_A,
		});
		// The module target is untouched, and a replay changes nothing more.
		expect(moved.forms[SOURCE]?.formLinks?.[1]?.target).toEqual({
			type: "module",
			moduleUuid: M1,
		});
		expect(
			apply(moved, [
				{ kind: "moveForm", uuid: TARGET_A, toModuleUuid: M0, after: SOURCE },
			]),
		).toEqual(moved);
		// The gate admits the move as one batch: the pair stays consistent.
		expect(
			mutationCommitVerdict(
				doc,
				[{ kind: "moveForm", uuid: TARGET_A, toModuleUuid: M0, after: SOURCE }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
		// The index follows: the source form now references the new module.
		expect(referencingCarrierUuids(moved, entityTargetKey(M0))).toContain(
			SOURCE,
		);
	});

	it("a missing form or link is a no-op, never a throw", () => {
		const doc = fixture();
		const ghost = testUuid("ghost");
		const stale: Mutation[] = [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: ghost,
				patch: { condition: null },
			},
			{ kind: "removeFormLink", formUuid: ghost, uuid: L1 },
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: ghost, after: null },
		];
		expect(
			mutationCommitVerdict(doc, stale, LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		const next = produce(doc, (draft) => {
			applyMutations(draft, stale);
		});
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

	it("the commit gate admits a valid add and refuses an otherwise that can never run", () => {
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
		// A destination added after one that runs every time runs too, in
		// order: nothing makes it unreachable.
		const everyTime = apply(doc, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L2,
				patch: { condition: null },
			},
		]);
		expect(
			mutationCommitVerdict(
				everyTime,
				[{ kind: "addFormLink", formUuid: SOURCE, link: newLink() }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
		// With no destination that may not run, an otherwise never runs.
		const verdict = mutationCommitVerdict(
			everyTime,
			[
				{
					kind: "updateFormLink",
					formUuid: SOURCE,
					uuid: L1,
					patch: { condition: null },
				},
				{
					kind: "setFormOtherwise",
					formUuid: SOURCE,
					otherwise: { kind: "destination", destination: "firstMenu" },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.findings.map((e) => e.code)).toContain(
				"FORM_OTHERWISE_UNREACHABLE",
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
			first.condition = eq(sessionUser("username"), literal("b"));
			form.formLinks = [
				first,
				{
					uuid: L3,
					condition: eq(sessionUser("username"), literal("c")),
					target: { type: "form", moduleUuid: M1, formUuid: TARGET_B },
				},
				second,
			];
		});
		assertAdmittedDoc(next);
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
			const link = draft.forms[SOURCE]?.formLinks?.[1];
			if (link === undefined) throw new Error("fixture");
			delete link.condition;
		});
		assertAdmittedDoc(next);
		expect(diffDocsToMutations(prev, next)).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L2,
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
				patch: {
					condition: eq(
						{ kind: "form-case", caseType: "patient", property: "status" },
						literal("open"),
					),
				},
			},
		]);
		const key = casePropertyTargetKey("patient", "status");
		expect(referencingCarrierUuids(doc, key)).toContain(SOURCE);

		const cleared = apply(doc, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { condition: { kind: "match-all" } },
			},
		]);
		expect(referencingCarrierUuids(cleared, key)).not.toContain(SOURCE);

		const readded = apply(cleared, [
			{
				kind: "addFormLink",
				formUuid: SOURCE,
				link: {
					uuid: L3,
					condition: eq(
						{ kind: "form-case", caseType: "patient", property: "status" },
						literal("open"),
					),
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

// ── The otherwise ─────────────────────────────────────────────────────

const builtIn: FormOtherwise = {
	kind: "destination",
	destination: "firstMenu",
};

const otherwiseLink = (uuid = OTHERWISE): FormOtherwise => ({
	kind: "link",
	uuid,
	target: { type: "form", moduleUuid: M1, formUuid: TARGET_B },
});

const setOtherwise = (otherwise: FormOtherwise | null): Mutation => ({
	kind: "setFormOtherwise",
	formUuid: SOURCE,
	otherwise,
});

describe("setFormOtherwise", () => {
	it("sets either arm, clears with null, and replays to the same document", () => {
		const doc = fixture();
		const withBuiltIn = apply(doc, [setOtherwise(builtIn)]);
		expect(withBuiltIn.forms[SOURCE]?.otherwise).toEqual(builtIn);
		expect(apply(withBuiltIn, [setOtherwise(builtIn)])).toEqual(withBuiltIn);

		const withLink = apply(withBuiltIn, [setOtherwise(otherwiseLink())]);
		expect(withLink.forms[SOURCE]?.otherwise).toEqual(otherwiseLink());
		expect(apply(withLink, [setOtherwise(otherwiseLink())])).toEqual(withLink);

		const cleared = apply(withLink, [setOtherwise(null)]);
		expect("otherwise" in (cleared.forms[SOURCE] ?? {})).toBe(false);
		// The four link kinds leave the otherwise alone.
		const moved = apply(withLink, [
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: L2, after: null },
		]);
		expect(moved.forms[SOURCE]?.otherwise).toEqual(otherwiseLink());
	});

	it("the schema admits both arms and null, and a form patch carries no otherwise", () => {
		expect(mutationSchema.safeParse(setOtherwise(builtIn)).success).toBe(true);
		expect(mutationSchema.safeParse(setOtherwise(null)).success).toBe(true);
		expect(
			mutationSchema.safeParse({
				...setOtherwise(null),
				otherwise: { kind: "destination", destination: "app_home" },
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateForm",
				uuid: SOURCE,
				patch: { otherwise: builtIn },
			}).success,
		).toBe(false);
	});

	it("addresses an existing form", () => {
		const doc = fixture();
		expect(mutationTargetsInvalid(doc, [setOtherwise(builtIn)])).toBe(false);
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "setFormOtherwise",
					formUuid: testUuid("ghost"),
					otherwise: builtIn,
				},
			]),
		).toBe(true);
	});

	it("moveForm carries a pointing otherwise link with the form", () => {
		const doc = apply(fixture(), [setOtherwise(otherwiseLink())]);
		const move: Mutation = {
			kind: "moveForm",
			uuid: TARGET_B,
			toModuleUuid: M0,
			after: SOURCE,
		};
		const moved = apply(doc, [move]);
		expect(moved.forms[SOURCE]?.otherwise).toEqual({
			kind: "link",
			uuid: OTHERWISE,
			target: { type: "form", moduleUuid: M0, formUuid: TARGET_B },
		});
		expect(apply(moved, [move])).toEqual(moved);
		expect(referencingCarrierUuids(moved, entityTargetKey(M0))).toContain(
			SOURCE,
		);
		expect(moved.refIndex).toEqual(buildReferenceIndex(moved));
	});
});

describe("otherwise identity", () => {
	const destinationToOtherwise: Mutation[] = [
		{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
		setOtherwise({
			kind: "link",
			uuid: L2,
			target: { type: "module", moduleUuid: M1 },
		}),
	];

	it("a link otherwise may take back the uuid of a destination the batch removed first", () => {
		const doc = fixture();
		expect(
			mutationIdentityAdmissionIssue(doc, destinationToOtherwise),
		).toBeUndefined();
		const converted = apply(doc, destinationToOtherwise);
		expect(linkOrder(converted)).toEqual([L1]);
		expect(converted.forms[SOURCE]?.otherwise).toMatchObject({ uuid: L2 });
		// And back: the otherwise leaves, then a destination takes its uuid.
		const back: Mutation[] = [
			setOtherwise(null),
			{
				kind: "addFormLink",
				formUuid: SOURCE,
				link: {
					uuid: L2,
					condition: eq(sessionUser("username"), literal("b")),
					target: { type: "module", moduleUuid: M1 },
				},
			},
		];
		expect(mutationIdentityAdmissionIssue(converted, back)).toBeUndefined();
		expect(apply(converted, back).forms[SOURCE]).toEqual(doc.forms[SOURCE]);
	});

	it("refuses a uuid something else holds, and a fresh uuid claimed twice", () => {
		const doc = fixture();
		// A destination still in place.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				setOtherwise({
					kind: "link",
					uuid: L1,
					target: { type: "module", moduleUuid: M1 },
				}),
			]),
		).toMatchObject({ uuid: L1, mutationKind: "setFormOtherwise" });
		// A destination another form's batch removed.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
				{
					kind: "setFormOtherwise",
					formUuid: TARGET_A,
					otherwise: {
						kind: "link",
						uuid: L2,
						target: { type: "module", moduleUuid: M0 },
					},
				},
			]),
		).toBeDefined();
		// A form's uuid.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				setOtherwise({
					kind: "link",
					uuid: TARGET_A,
					target: { type: "module", moduleUuid: M1 },
				}),
			]),
		).toBeDefined();
		// One fresh uuid, claimed by two forms' otherwise links.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				setOtherwise(otherwiseLink()),
				{
					kind: "setFormOtherwise",
					formUuid: TARGET_A,
					otherwise: otherwiseLink(),
				},
			]),
		).toBeDefined();
		// A destination added beside an otherwise link of the same uuid.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				setOtherwise(otherwiseLink()),
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: { uuid: OTHERWISE, target: { type: "module", moduleUuid: M1 } },
				},
			]),
		).toBeDefined();
		// A removed destination never comes back as a destination.
		expect(
			mutationIdentityAdmissionIssue(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: { uuid: L2, target: { type: "module", moduleUuid: M1 } },
				},
			]),
		).toBeDefined();
		// Keeping the otherwise link's own uuid claims nothing new.
		const linked = apply(doc, [setOtherwise(otherwiseLink())]);
		expect(
			mutationIdentityAdmissionIssue(linked, [
				setOtherwise({
					kind: "link",
					uuid: OTHERWISE,
					target: { type: "module", moduleUuid: M1 },
				}),
			]),
		).toBeUndefined();
	});

	it("sequence admission admits the conversion order", () => {
		const doc = fixture();
		expect(
			mutationSequenceAdmissionIssue(doc, destinationToOtherwise),
		).toBeUndefined();
	});
});

describe("otherwise diff and undo", () => {
	it("emits setFormOtherwise for a changed otherwise and a clear as null", () => {
		const prev = fixture();
		const next = apply(prev, [setOtherwise(builtIn)]);
		expect(diffDocsToMutations(prev, next)).toEqual([setOtherwise(builtIn)]);
		expect(diffDocsToMutations(next, prev)).toEqual([setOtherwise(null)]);
	});

	it("a destination that becomes the otherwise, and back, replays through the gate", () => {
		const prev = fixture();
		const converted = apply(prev, destinationToOtherwiseBatch());
		const forward = diffDocsToMutations(prev, converted);
		expect(forward.map((m) => m.kind)).toEqual([
			"removeFormLink",
			"setFormOtherwise",
		]);
		expect(apply(prev, forward).forms[SOURCE]).toEqual(converted.forms[SOURCE]);
		const backward = diffDocsToMutations(converted, prev);
		expect(backward.map((m) => m.kind)).toEqual([
			"setFormOtherwise",
			"addFormLink",
		]);
		expect(apply(converted, backward).forms[SOURCE]).toEqual(
			prev.forms[SOURCE],
		);
	});

	it("an otherwise and a destination that trade places replay", () => {
		const prev = apply(fixture(), [setOtherwise(otherwiseLink())]);
		const next = produce(prev, (draft) => {
			const form = draft.forms[SOURCE];
			if (form?.formLinks === undefined) throw new Error("fixture");
			form.formLinks = [
				form.formLinks[0] as FormLink,
				{
					uuid: OTHERWISE,
					condition: eq(sessionUser("username"), literal("c")),
					target: { type: "form", moduleUuid: M1, formUuid: TARGET_B },
				},
			];
			form.otherwise = {
				kind: "link",
				uuid: L2,
				target: { type: "module", moduleUuid: M1 },
			};
		});
		assertAdmittedDoc(next);
		const mutations = diffDocsToMutations(prev, next);
		expect(mutations.map((m) => m.kind)).toEqual([
			"setFormOtherwise",
			"addFormLink",
			"removeFormLink",
			"setFormOtherwise",
		]);
		expect(apply(prev, mutations).forms[SOURCE]).toEqual(next.forms[SOURCE]);
	});

	it("undo restores the prior otherwise", () => {
		const doc = apply(fixture(), [setOtherwise(builtIn)]);
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(doc));
		store.getState().startTracking();
		store
			.getState()
			.applyMany(admitMutationBatch([setOtherwise(otherwiseLink())]));
		expect(store.getState().forms[SOURCE]?.otherwise).toEqual(otherwiseLink());
		store.getState().undo();
		expect(store.getState().forms[SOURCE]?.otherwise).toEqual(builtIn);
		store.getState().redo();
		expect(store.getState().forms[SOURCE]?.otherwise).toEqual(otherwiseLink());
	});
});

function destinationToOtherwiseBatch(): Mutation[] {
	return [
		{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
		setOtherwise({
			kind: "link",
			uuid: L2,
			target: { type: "module", moduleUuid: M1 },
		}),
	];
}

describe("otherwise in the reference index", () => {
	it("indexes the otherwise link's target and carried values, and the incremental index equals a rebuild", () => {
		const doc = fixture();
		const linked = apply(doc, [
			setOtherwise({
				kind: "link",
				uuid: OTHERWISE,
				target: { type: "module", moduleUuid: M0 },
			}),
		]);
		expect(referencingCarrierUuids(linked, entityTargetKey(M0))).toContain(
			SOURCE,
		);
		expect(linked.refIndex).toEqual(buildReferenceIndex(linked));

		const builtInOnly = apply(linked, [setOtherwise(builtIn)]);
		expect(
			referencingCarrierUuids(builtInOnly, entityTargetKey(M0)),
		).not.toContain(SOURCE);
		expect(builtInOnly.refIndex).toEqual(buildReferenceIndex(builtInOnly));

		const converted = apply(doc, destinationToOtherwiseBatch());
		expect(converted.refIndex).toEqual(buildReferenceIndex(converted));
	});
});
