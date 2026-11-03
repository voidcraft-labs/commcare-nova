/**
 * The after-submit planners: the plan of a form's destinations and its
 * otherwise (`afterSubmitPlan`), and how add / update / remove / move /
 * set-otherwise / make-otherwise / make-destination become gated batches,
 * with the form's after-submit and otherwise settled in the same batch.
 * Every `ok` plan is replayed through the reducers AND the commit gate, so a
 * planner cannot promise a shape the validator refuses.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	afterSubmitPlan,
	type FormLinkCommitPlan,
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planMakeDestination,
	planMakeOtherwise,
	planSetOtherwise,
} from "@/lib/doc/formLinkMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationSchema } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	FormLink,
	FormOtherwise,
	PostSubmitDestination,
} from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression/builders";
import type {
	Expression,
	FormLinkDatumName,
} from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SUB = testUuid("mod-sub");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const ELSE = testUuid("lnk-else");

interface Spec {
	uuid: string;
	condition?: string | Expression;
	target: FormLink["target"];
	datums?: Array<{ name: FormLinkDatumName; xpath: string }>;
}

const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;
const toSub = { type: "module", moduleUuid: SUB } as const;

/**
 * Intake (patient) → [Source (registration: it creates the case a Visit
 * link carries)]; Care (patient) → [Visit (followup), Note (survey)]; Sub,
 * a submenu of Care → [Sub note (survey)]. HQ's form settings page does not
 * offer Sub as a link target from Source, a form of a root menu.
 * `postSubmit` and `otherwise` are stored only when a test says so.
 */
function fixture(
	links: Spec[],
	opts: {
		postSubmit?: PostSubmitDestination;
		otherwise?: FormOtherwise;
	} = {},
): BlueprintDoc {
	const built = buildDoc({
		appName: "Links",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: "registration",
						...(opts.postSubmit !== undefined && {
							postSubmit: opts.postSubmit,
						}),
						...(links.length > 0 && { formLinks: links }),
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-note",
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "n", label: proseText("N") })],
					},
				],
			},
			{
				uuid: "mod-sub",
				name: "Sub",
				forms: [
					{
						uuid: "frm-sub-note",
						name: "Sub note",
						type: "survey",
						fields: [f({ kind: "text", id: "s", label: proseText("S") })],
					},
				],
			},
		],
	});
	const doc = produce(built, (draft) => {
		draft.modules[SUB].parentModuleUuid = CARE;
		if (opts.otherwise !== undefined)
			draft.forms[SOURCE].otherwise = opts.otherwise;
	});
	assertAdmittedDoc(doc);
	return doc;
}

const cond = (
	uuid: string,
	text: string,
	target: FormLink["target"] = toNote,
): Spec => ({
	uuid,
	condition: text,
	target,
});
const everyTime = (
	uuid: string,
	target: FormLink["target"] = toCare,
): Spec => ({
	uuid,
	target,
});
const linkOtherwise = (
	uuid: string = ELSE,
	target: FormLink["target"] = toCare,
): FormOtherwise => ({ kind: "link", uuid: testUuid(uuid), target });
const builtIn = (destination: "module" | "previous" | "firstMenu") =>
	({ kind: "destination", destination }) as const;

/** Replay an ok plan through the reducers and the gate; return the doc. */
function commit(doc: BlueprintDoc, plan: FormLinkCommitPlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.reason)}`);
	const verdict = mutationCommitVerdict(
		doc,
		plan.mutations.map((mutation) =>
			mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
		),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`gate refused: ${verdict.findings.map((e) => e.code).join(", ")}`,
		);
	}
	return verdict.nextDoc;
}

const order = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid) ?? [];

const newLink = (
	uuid: string,
	condition?: Expression,
	target: FormLink["target"] = toNote,
): FormLink => ({
	uuid: testUuid(uuid),
	...(condition !== undefined && { condition }),
	target,
});

const ONE = eq(literal(1), literal(1));

/** Two compatible patient collections. Direct form links work only while
 * CommCare may carry the collection automatically (no explicit datum map). */
function multipleSelectionFixture(links: Spec[] = []): BlueprintDoc {
	const doc = produce(
		fixture(links, links.length === 0 ? { postSubmit: "app_home" } : {}),
		(draft) => {
			const source = draft.modules[INTAKE]?.caseListConfig;
			const target = draft.modules[CARE]?.caseListConfig;
			if (source === undefined || target === undefined)
				throw new Error("fixture");
			source.selection = { kind: "multiple", maximum: 10 };
			target.selection = { kind: "multiple", maximum: 10 };
			// Choosing several cases runs in Web Apps alone.
			draft.appSettings.runsOnlyOn = "web-apps";
			draft.forms[SOURCE].type = "followup";
			// Neither form saves an answer to its cases, nor opens a question
			// with one selected case's value.
			for (const formUuid of [SOURCE, VISIT]) {
				for (const operation of draft.forms[formUuid]?.caseOperations ?? []) {
					if (operation.action !== "own") continue;
					delete operation.name;
					delete operation.writes;
				}
				for (const fieldUuid of draft.fieldOrder[formUuid] ?? []) {
					const field = draft.fields[fieldUuid];
					if (field !== undefined && "default_value" in field)
						delete field.default_value;
				}
			}
		},
	);
	assertAdmittedDoc(doc);
	return doc;
}

function expectSelectionCardinalityRefusal(
	doc: BlueprintDoc,
	mutations: Parameters<typeof mutationCommitVerdict>[1],
): void {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok).toBe(false);
	if (verdict.ok) return;
	expect(verdict.findings.map((finding) => finding.code)).toContain(
		"FORM_LINK_SELECTION_CARDINALITY",
	);
}

/** The gate's codes for a batch that is refused. */
function refusedCodes(
	doc: BlueprintDoc,
	mutations: Parameters<typeof mutationCommitVerdict>[1],
): string[] {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	return verdict.ok ? [] : verdict.findings.map((finding) => finding.code);
}

describe("afterSubmitPlan", () => {
	it("reads the form-type default of a form without destinations", () => {
		expect(afterSubmitPlan(fixture([]), SOURCE)).toEqual({
			destinations: [],
			mayNotRun: [],
			otherwise: undefined,
			otherwiseOffered: false,
			postSubmit: { destination: "app_home", explicit: false },
		});
		expect(
			afterSubmitPlan(fixture([], { postSubmit: "module" }), SOURCE)
				?.postSubmit,
		).toEqual({ destination: "module", explicit: true });
	});

	it("names the destinations that may not run, and offers an otherwise beside them", () => {
		const plan = afterSubmitPlan(
			fixture([cond("lnk-1", "1 = 1"), everyTime("lnk-2")], {
				otherwise: builtIn("module"),
			}),
			SOURCE,
		);
		expect(plan?.destinations.map((link) => link.uuid)).toEqual([L1, L2]);
		expect(plan?.mayNotRun.map((link) => link.uuid)).toEqual([L1]);
		expect(plan?.otherwise).toEqual(builtIn("module"));
		expect(plan?.otherwiseOffered).toBe(true);
		expect(plan?.postSubmit).toBeUndefined();
	});

	it("counts a carried case as a destination that may not run", () => {
		const plan = afterSubmitPlan(
			fixture([
				{
					uuid: "lnk-1",
					target: toVisit,
					datums: [
						{ name: { kind: "selected-case", module: CARE }, xpath: "'x'" },
					],
				},
			]),
			SOURCE,
		);
		expect(plan?.mayNotRun.map((link) => link.uuid)).toEqual([L1]);
		expect(plan?.otherwiseOffered).toBe(true);
	});

	it("offers no otherwise when every destination runs each time", () => {
		const plan = afterSubmitPlan(fixture([everyTime("lnk-1")]), SOURCE);
		expect(plan?.mayNotRun).toEqual([]);
		expect(plan?.otherwiseOffered).toBe(false);
	});

	it("is undefined for a missing form", () => {
		expect(afterSubmitPlan(fixture([]), testUuid("ghost"))).toBeUndefined();
	});
});

describe("planFormLinkAdd", () => {
	it("refuses an explicit datum map the gate cannot use for a collection", () => {
		const doc = multipleSelectionFixture();
		const link: FormLink = {
			uuid: L1,
			condition: ONE,
			target: toVisit,
			datums: [
				{
					name: { kind: "selected-case", module: CARE },
					xpath: term(literal("patient-id")),
				},
			],
		};

		expectSelectionCardinalityRefusal(doc, [
			{ kind: "addFormLink", formUuid: SOURCE, link },
			{ kind: "updateForm", uuid: SOURCE, patch: { postSubmit: null } },
		]);
		expect(planFormLinkAdd(doc, SOURCE, link)).toEqual({
			ok: false,
			reason: { kind: "selection-cardinality" },
		});

		const { datums: _manual, ...automatic } = link;
		commit(doc, planFormLinkAdd(doc, SOURCE, automatic));
	});

	it("moves a stored after-submit into the otherwise beside the first destination that may not run", () => {
		const doc = fixture([], { postSubmit: "module" });
		// The plausible failure: the new destination beside the old
		// `postSubmit`, which the gate refuses.
		expect(
			refusedCodes(doc, [
				{ kind: "addFormLink", formUuid: SOURCE, link: newLink("lnk-1", ONE) },
			]),
		).toContain("POST_SUBMIT_BESIDE_FORM_LINKS");
		const plan = planFormLinkAdd(doc, SOURCE, newLink("lnk-1", ONE));
		expect(plan).toMatchObject({ ok: true, movedToOtherwise: "module" });
		if (!plan.ok) return;
		expect(plan.droppedPostSubmit).toBeUndefined();
		expect(plan.mutations.map((m) => m.kind)).toEqual([
			"addFormLink",
			"updateForm",
			"setFormOtherwise",
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(next.forms[SOURCE]?.otherwise).toEqual(builtIn("module"));
		expect(order(next)).toEqual([L1]);
	});

	it("moves a defaulted after-submit too, so the worker still goes there when the condition is false", () => {
		// Visit is a follow-up: its default is the previous screen.
		const doc = fixture([]);
		const plan = planFormLinkAdd(doc, VISIT, newLink("lnk-1", ONE, toCare));
		expect(plan).toMatchObject({ ok: true, movedToOtherwise: "previous" });
		const next = commit(doc, plan);
		expect(next.forms[VISIT]?.otherwise).toEqual(builtIn("previous"));
	});

	it("drops a stored after-submit an every-time destination leaves unreached, and says so", () => {
		const doc = fixture([], { postSubmit: "module" });
		const plan = planFormLinkAdd(
			doc,
			SOURCE,
			newLink("lnk-1", undefined, toCare),
		);
		expect(plan).toMatchObject({ ok: true, droppedPostSubmit: "module" });
		if (!plan.ok) return;
		expect(plan.movedToOtherwise).toBeUndefined();
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("leaves the app home as no otherwise, reporting nothing dropped", () => {
		const stored = fixture([], { postSubmit: "app_home" });
		const plan = planFormLinkAdd(stored, SOURCE, newLink("lnk-1", ONE));
		expect(plan.ok && plan.mutations.map((m) => m.kind)).toEqual([
			"addFormLink",
			"updateForm",
		]);
		expect(plan.ok && plan.movedToOtherwise).toBeUndefined();
		expect(plan.ok && plan.droppedPostSubmit).toBeUndefined();
		expect(commit(stored, plan).forms[SOURCE]?.otherwise).toBeUndefined();
		const defaulted = fixture([]);
		const bare = planFormLinkAdd(defaulted, SOURCE, newLink("lnk-1", ONE));
		expect(bare.ok && bare.mutations.map((m) => m.kind)).toEqual([
			"addFormLink",
		]);
		commit(defaulted, bare);
	});

	it("changes nothing else on a form with destinations, at any position", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], {
			otherwise: builtIn("module"),
		});
		const first = planFormLinkAdd(
			doc,
			SOURCE,
			newLink("lnk-2", undefined, toCare),
			null,
		);
		expect(first.ok && first.mutations).toEqual([
			{
				kind: "addFormLink",
				formUuid: SOURCE,
				link: newLink("lnk-2", undefined, toCare),
				after: null,
			},
		]);
		const next = commit(doc, first);
		expect(order(next)).toEqual([L2, L1]);
		expect(next.forms[SOURCE]?.otherwise).toEqual(builtIn("module"));
		const last = planFormLinkAdd(doc, SOURCE, newLink("lnk-2", ONE), L1);
		expect(order(commit(doc, last))).toEqual([L1, L2]);
	});

	it("refuses a uuid in use, a self target, a missing target or anchor, an unoffered submenu and values on a menu", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		expect(planFormLinkAdd(doc, SOURCE, newLink("lnk-1", ONE))).toEqual({
			ok: false,
			reason: { kind: "duplicate-uuid", uuid: L1 },
		});
		expect(
			planFormLinkAdd(doc, SOURCE, {
				uuid: NOTE,
				condition: ONE,
				target: toCare,
			}),
		).toEqual({ ok: false, reason: { kind: "duplicate-uuid", uuid: NOTE } });
		expect(
			planFormLinkAdd(
				doc,
				SOURCE,
				newLink("lnk-2", ONE, {
					type: "form",
					moduleUuid: INTAKE,
					formUuid: SOURCE,
				}),
			),
		).toEqual({ ok: false, reason: { kind: "self-target" } });
		expect(
			planFormLinkAdd(
				doc,
				SOURCE,
				newLink("lnk-2", ONE, {
					type: "form",
					moduleUuid: CARE,
					formUuid: testUuid("ghost"),
				}),
			),
		).toEqual({ ok: false, reason: { kind: "target-not-found" } });
		expect(
			planFormLinkAdd(doc, SOURCE, newLink("lnk-2", ONE), testUuid("ghost")),
		).toEqual({
			ok: false,
			reason: { kind: "link-not-found", uuid: testUuid("ghost") },
		});
		expect(
			refusedCodes(doc, [
				{
					kind: "addFormLink",
					formUuid: SOURCE,
					link: newLink("lnk-2", ONE, toSub),
				},
			]),
		).toContain("FORM_LINK_TARGET_NOT_OFFERED");
		expect(planFormLinkAdd(doc, SOURCE, newLink("lnk-2", ONE, toSub))).toEqual({
			ok: false,
			reason: { kind: "target-not-offered", menuUuid: SUB, parentUuid: CARE },
		});
		expect(
			planFormLinkAdd(doc, SOURCE, {
				...newLink("lnk-2", ONE, toCare),
				datums: [
					{
						name: { kind: "selected-case", module: CARE },
						xpath: term(literal("x")),
					},
				],
			}),
		).toEqual({ ok: false, reason: { kind: "menu-carries-values" } });
	});

	it("admits starting this form again", () => {
		const doc = fixture([]);
		const plan = planFormLinkAdd(
			doc,
			SOURCE,
			newLink("lnk-1", ONE, { type: "this-form" }),
		);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.formLinks?.[0]?.target).toEqual({
			type: "this-form",
		});
	});
});

describe("planFormLinkUpdate", () => {
	const base = (doc: BlueprintDoc, uuid: string): FormLink => {
		const link = doc.forms[SOURCE]?.formLinks?.find(
			(l) => l.uuid === testUuid(uuid),
		);
		if (link === undefined) throw new Error("fixture");
		return link;
	};

	it("refuses datum-only and retarget edits that the collection gate refuses", () => {
		const held: NonNullable<FormLink["datums"]> = [
			{
				name: { kind: "selected-case", module: CARE },
				xpath: term(literal("patient-id")),
			},
		];
		const direct = multipleSelectionFixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toVisit },
		]);
		const current = base(direct, "lnk-1");
		const withDatums = { ...current, datums: held };
		expectSelectionCardinalityRefusal(direct, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { datums: held },
			},
		]);
		expect(planFormLinkUpdate(direct, SOURCE, withDatums, current)).toEqual({
			ok: false,
			reason: { kind: "selection-cardinality" },
		});

		const beforeRetarget = multipleSelectionFixture([
			{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
		]);
		const prior = base(beforeRetarget, "lnk-1");
		const retargeted = { ...prior, target: toVisit, datums: held };
		expectSelectionCardinalityRefusal(beforeRetarget, [
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { target: toVisit, datums: held },
			},
		]);
		expect(
			planFormLinkUpdate(beforeRetarget, SOURCE, retargeted, prior),
		).toEqual({
			ok: false,
			reason: { kind: "selection-cardinality" },
		});
	});

	it("writes only the changed slots and clears with null", () => {
		// Visit needs a case: the registration carries the one it creates, or
		// the link names one by hand.
		const doc = fixture([cond("lnk-1", "1 = 1", toVisit)]);
		const current = base(doc, "lnk-1");
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{
				...current,
				condition: eq(literal(2), literal(2)),
				datums: [
					{
						name: { kind: "selected-case", module: CARE },
						xpath: term(literal("x")),
					},
				],
			},
			current,
		);
		expect(plan).toMatchObject({ ok: true });
		if (!plan.ok) return;
		expect(plan.mutations).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: {
					condition: eq(literal(2), literal(2)),
					datums: [
						{
							name: { kind: "selected-case", module: CARE },
							xpath: term(literal("x")),
						},
					],
				},
			},
		]);
		const next = commit(doc, plan);
		const cleared = planFormLinkUpdate(
			next,
			SOURCE,
			{ ...base(next, "lnk-1"), datums: undefined },
			base(next, "lnk-1"),
		);
		expect(cleared.ok && cleared.mutations).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { datums: null },
			},
		]);
	});

	it("drops the carried values a new destination never reads, and says so", () => {
		// Visit needs a case; the link names one by hand. Retargeting it at
		// Note (a survey: it needs nothing) with the values left alone would
		// store a name Note never reads (`FORM_LINK_DATUM_UNUSED`), so the
		// planner removes it and reports it. Values the caller sets in the
		// same edit are its own.
		const doc = fixture([
			{
				uuid: "lnk-1",
				condition: "1 = 1",
				target: toVisit,
				datums: [
					{ name: { kind: "selected-case", module: CARE }, xpath: "'x'" },
				],
			},
		]);
		const current = base(doc, "lnk-1");
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...current, target: toNote },
			current,
		);
		expect(plan).toMatchObject({ ok: true, droppedDatums: ["case_id"] });
		expect(plan.ok && plan.mutations).toEqual([
			{
				kind: "updateFormLink",
				formUuid: SOURCE,
				uuid: L1,
				patch: { target: toNote, datums: null },
			},
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.formLinks?.[0]?.datums).toBeUndefined();

		// A module target needs nothing carried either.
		const toModule = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...current, target: toCare },
			current,
		);
		expect(toModule).toMatchObject({ ok: true, droppedDatums: ["case_id"] });
		commit(doc, toModule);

		// Naming the values in the same edit is the caller's decision.
		const explicit = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...current, target: toNote, datums: undefined },
			current,
		);
		expect(explicit.ok && explicit.droppedDatums).toBeUndefined();
		commit(doc, explicit);
	});

	it("is a no-op plan when nothing changed, whatever the key order", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const current = base(doc, "lnk-1");
		expect(planFormLinkUpdate(doc, SOURCE, { ...current }, current)).toEqual({
			ok: true,
			mutations: [],
		});
		// A caller re-sending the same target with its keys in another order
		// (the stored document sorts them) has changed nothing.
		const reordered = {
			...current,
			target: { formUuid: NOTE, moduleUuid: CARE, type: "form" as const },
		};
		expect(planFormLinkUpdate(doc, SOURCE, reordered, current)).toEqual({
			ok: true,
			mutations: [],
		});
	});

	it("refuses a slot someone else changed first, and a vanished link", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const opened = base(doc, "lnk-1");
		const peerEdited = produce(doc, (draft) => {
			const link = draft.forms[SOURCE]?.formLinks?.[0];
			if (link === undefined) throw new Error("fixture");
			link.condition = eq(literal(9), literal(9));
		});
		expect(
			planFormLinkUpdate(
				peerEdited,
				SOURCE,
				{ ...opened, condition: eq(literal(2), literal(2)) },
				opened,
			),
		).toEqual({ ok: false, reason: { kind: "stale-base" } });
		// A different slot is fine: the rebase keeps the peer's condition.
		const retarget = planFormLinkUpdate(
			peerEdited,
			SOURCE,
			{
				...opened,
				target: toVisit,
				datums: [
					{
						name: { kind: "selected-case", module: CARE },
						xpath: term(literal("p")),
					},
				],
			},
			opened,
		);
		assertAdmittedDoc(peerEdited);
		expect(retarget.ok && retarget.mutations[0]).toMatchObject({
			patch: { target: toVisit },
		});
		const rebased = commit(peerEdited, retarget);
		expect(rebased.forms[SOURCE].formLinks?.[0]).toMatchObject({
			condition: eq(literal(9), literal(9)),
			target: toVisit,
		});
		expect(
			planFormLinkUpdate(
				fixture([]),
				SOURCE,
				{ ...opened, condition: eq(literal(2), literal(2)) },
				opened,
			),
		).toEqual({ ok: false, reason: { kind: "link-not-found", uuid: L1 } });
	});

	it("removes the otherwise when an update leaves no destination that may not run", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), everyTime("lnk-2")], {
			otherwise: builtIn("module"),
		});
		const current = base(doc, "lnk-1");
		const next = { ...current, condition: undefined };
		// The plausible failure: an otherwise stranded beside destinations
		// that all run every time.
		expect(
			refusedCodes(doc, [
				{
					kind: "updateFormLink",
					formUuid: SOURCE,
					uuid: L1,
					patch: { condition: null },
				},
			]),
		).toContain("FORM_OTHERWISE_UNREACHABLE");
		const plan = planFormLinkUpdate(doc, SOURCE, next, current);
		expect(plan).toMatchObject({
			ok: true,
			droppedOtherwise: builtIn("module"),
		});
		expect(plan.ok && plan.mutations.map((m) => m.kind)).toEqual([
			"updateFormLink",
			"setFormOtherwise",
		]);
		expect(commit(doc, plan).forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("keeps the otherwise while another destination may not run", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2")], {
			otherwise: builtIn("module"),
		});
		const current = base(doc, "lnk-1");
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...current, condition: undefined },
			current,
		);
		expect(plan.ok && plan.droppedOtherwise).toBeUndefined();
		expect(commit(doc, plan).forms[SOURCE]?.otherwise).toEqual(
			builtIn("module"),
		);
	});

	it("refuses a retarget to a submenu HQ does not offer from here", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const current = base(doc, "lnk-1");
		expect(
			planFormLinkUpdate(doc, SOURCE, { ...current, target: toSub }, current),
		).toEqual({
			ok: false,
			reason: { kind: "target-not-offered", menuUuid: SUB, parentUuid: CARE },
		});
	});
});

describe("planFormLinkRemove", () => {
	it("turns a built-in otherwise into the form's after-submit when the last destination goes", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], {
			otherwise: builtIn("module"),
		});
		const plan = planFormLinkRemove(doc, SOURCE, L1);
		expect(plan).toMatchObject({ ok: true, otherwiseToPostSubmit: "module" });
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.formLinks).toBeUndefined();
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
		expect(next.forms[SOURCE]?.postSubmit).toBe("module");
	});

	it("turns an otherwise link into the sole destination, keeping its uuid", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], {
			otherwise: linkOtherwise(),
		});
		// The plausible failure: the otherwise left beside no destinations.
		expect(
			refusedCodes(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: L1 },
			]),
		).toContain("FORM_OTHERWISE_UNREACHABLE");
		const plan = planFormLinkRemove(doc, SOURCE, L1);
		expect(plan).toMatchObject({ ok: true, otherwiseToDestination: ELSE });
		expect(plan.ok && plan.mutations.map((m) => m.kind)).toEqual([
			"removeFormLink",
			"setFormOtherwise",
			"addFormLink",
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.formLinks).toEqual([
			{ uuid: ELSE, target: toCare },
		]);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("gives the form its type's default when no otherwise is stored", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const plan = planFormLinkRemove(doc, SOURCE, L1);
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L1 },
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(afterSubmitPlan(next, SOURCE)?.postSubmit).toEqual({
			destination: "app_home",
			explicit: false,
		});
	});

	it("removes the otherwise with the last destination that may not run", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), everyTime("lnk-2")], {
			otherwise: linkOtherwise(),
		});
		const plan = planFormLinkRemove(doc, SOURCE, L1);
		expect(plan).toMatchObject({
			ok: true,
			droppedOtherwise: linkOtherwise(),
		});
		const next = commit(doc, plan);
		expect(order(next)).toEqual([L2]);
		expect(next.forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("refuses a link that is not there", () => {
		expect(planFormLinkRemove(fixture([]), SOURCE, L1)).toEqual({
			ok: false,
			reason: { kind: "link-not-found", uuid: L1 },
		});
	});
});

describe("planFormLinkMove", () => {
	const doc = () =>
		fixture(
			[cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2"), everyTime("lnk-else")],
			{ otherwise: builtIn("module") },
		);

	it("moves by anchor to any position and replays to the same order", () => {
		const plan = planFormLinkMove(doc(), SOURCE, L2, 0);
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: L2, after: null },
		]);
		expect(order(commit(doc(), plan))).toEqual([L2, L1, ELSE]);
		// An every-time destination may come first, and a conditional one last.
		expect(
			order(commit(doc(), planFormLinkMove(doc(), SOURCE, ELSE, 0))),
		).toEqual([ELSE, L1, L2]);
		expect(
			order(commit(doc(), planFormLinkMove(doc(), SOURCE, L1, 2))),
		).toEqual([L2, ELSE, L1]);
	});

	it("is a no-op plan at the current position, and refuses a missing link", () => {
		expect(planFormLinkMove(doc(), SOURCE, L1, 0)).toEqual({
			ok: true,
			mutations: [],
		});
		expect(planFormLinkMove(doc(), SOURCE, testUuid("ghost"), 0)).toEqual({
			ok: false,
			reason: { kind: "link-not-found", uuid: testUuid("ghost") },
		});
	});
});

describe("planSetOtherwise", () => {
	it("sets a built-in otherwise and clears it with null", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const plan = planSetOtherwise(doc, SOURCE, builtIn("module"));
		expect(plan.ok && plan.mutations).toEqual([
			{
				kind: "setFormOtherwise",
				formUuid: SOURCE,
				otherwise: builtIn("module"),
			},
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.otherwise).toEqual(builtIn("module"));
		expect(planSetOtherwise(next, SOURCE, builtIn("module"))).toEqual({
			ok: true,
			mutations: [],
		});
		const cleared = planSetOtherwise(next, SOURCE, null);
		expect(commit(next, cleared).forms[SOURCE]?.otherwise).toBeUndefined();
		expect(planSetOtherwise(doc, SOURCE, null)).toEqual({
			ok: true,
			mutations: [],
		});
	});

	it("sets a link the caller minted, and changes it keeping its uuid", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const next = commit(doc, planSetOtherwise(doc, SOURCE, linkOtherwise()));
		expect(next.forms[SOURCE]?.otherwise).toEqual(linkOtherwise());
		const retargeted = linkOtherwise("lnk-else", toNote);
		expect(
			commit(next, planSetOtherwise(next, SOURCE, retargeted)).forms[SOURCE]
				?.otherwise,
		).toEqual(retargeted);
		// A built-in in its place.
		expect(
			commit(next, planSetOtherwise(next, SOURCE, builtIn("previous"))).forms[
				SOURCE
			]?.otherwise,
		).toEqual(builtIn("previous"));
	});

	it("refuses an otherwise that could never run", () => {
		for (const doc of [fixture([]), fixture([everyTime("lnk-1")])]) {
			expect(planSetOtherwise(doc, SOURCE, builtIn("module"))).toEqual({
				ok: false,
				reason: { kind: "otherwise-unreachable" },
			});
		}
	});

	it("refuses a built-in the menu does not offer, naming why", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		expect(
			planSetOtherwise(doc, SOURCE, {
				kind: "destination",
				destination: "parentMenu",
			}),
		).toEqual({
			ok: false,
			reason: {
				kind: "otherwise-not-offered",
				destination: "parentMenu",
				reason: "no-parent-menu",
			},
		});
	});

	it("refuses a link whose uuid is in use, or whose target a destination could not take", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		expect(planSetOtherwise(doc, SOURCE, linkOtherwise("lnk-1"))).toEqual({
			ok: false,
			reason: { kind: "duplicate-uuid", uuid: L1 },
		});
		expect(
			planSetOtherwise(doc, SOURCE, {
				kind: "link",
				uuid: ELSE,
				target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
			}),
		).toEqual({ ok: false, reason: { kind: "self-target" } });
		expect(
			planSetOtherwise(doc, SOURCE, linkOtherwise("lnk-else", toSub)),
		).toEqual({
			ok: false,
			reason: { kind: "target-not-offered", menuUuid: SUB, parentUuid: CARE },
		});
		expect(
			planSetOtherwise(doc, SOURCE, {
				kind: "link",
				uuid: ELSE,
				target: toCare,
				datums: [
					{
						name: { kind: "selected-case", module: CARE },
						xpath: term(literal("x")),
					},
				],
			}),
		).toEqual({ ok: false, reason: { kind: "menu-carries-values" } });
	});

	it("refuses a form that is gone", () => {
		expect(
			planSetOtherwise(fixture([]), testUuid("ghost"), builtIn("module")),
		).toEqual({ ok: false, reason: { kind: "form-not-found" } });
	});
});

describe("planMakeOtherwise / planMakeDestination", () => {
	it("turns a destination into the otherwise link and back, keeping its uuid", () => {
		const doc = fixture([
			cond("lnk-1", "1 = 1"),
			cond("lnk-2", "2 = 2", toCare),
		]);
		const plan = planMakeOtherwise(doc, SOURCE, L2);
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: L2 },
			{
				kind: "setFormOtherwise",
				formUuid: SOURCE,
				otherwise: { kind: "link", uuid: L2, target: toCare },
			},
		]);
		const made = commit(doc, plan);
		expect(order(made)).toEqual([L1]);
		expect(made.forms[SOURCE]?.otherwise).toEqual({
			kind: "link",
			uuid: L2,
			target: toCare,
		});
		const back = commit(made, planMakeDestination(made, SOURCE));
		expect(order(back)).toEqual([L1, L2]);
		expect(back.forms[SOURCE]?.formLinks?.[1]).toEqual({
			uuid: L2,
			target: toCare,
		});
		expect(back.forms[SOURCE]?.otherwise).toBeUndefined();
	});

	it("refuses a make-otherwise that leaves nothing that may not run", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), everyTime("lnk-2")]);
		// The plausible failure: the batch the gate refuses.
		expect(
			refusedCodes(doc, [
				{ kind: "removeFormLink", formUuid: SOURCE, uuid: L1 },
				{
					kind: "setFormOtherwise",
					formUuid: SOURCE,
					otherwise: { kind: "link", uuid: L1, target: toNote },
				},
			]),
		).toContain("FORM_OTHERWISE_UNREACHABLE");
		expect(planMakeOtherwise(doc, SOURCE, L1)).toEqual({
			ok: false,
			reason: { kind: "otherwise-unreachable" },
		});
		expect(
			planMakeOtherwise(fixture([cond("lnk-1", "1 = 1")]), SOURCE, L1),
		).toEqual({ ok: false, reason: { kind: "otherwise-unreachable" } });
		// The every-time destination as the otherwise is fine.
		commit(doc, planMakeOtherwise(doc, SOURCE, L2));
	});

	it("refuses a second otherwise, a missing link, and a built-in to make a destination", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2")], {
			otherwise: builtIn("module"),
		});
		expect(planMakeOtherwise(doc, SOURCE, L2)).toEqual({
			ok: false,
			reason: { kind: "otherwise-exists" },
		});
		expect(planMakeOtherwise(doc, SOURCE, ELSE)).toEqual({
			ok: false,
			reason: { kind: "link-not-found", uuid: ELSE },
		});
		expect(planMakeDestination(doc, SOURCE)).toEqual({
			ok: false,
			reason: { kind: "no-otherwise-link" },
		});
		expect(planMakeDestination(fixture([]), SOURCE)).toEqual({
			ok: false,
			reason: { kind: "no-otherwise-link" },
		});
	});
});
