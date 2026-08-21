/**
 * The after-submit planners: what runs when nothing matched
 * (`afterSubmitPlan`), and how add / update / remove / move / set-fallback
 * become gated batches — including the fallback pin that keeps every
 * produced document on the right side of `FORM_LINK_NO_FALLBACK`. Every
 * `ok` plan is replayed through the reducers AND the commit gate, so a
 * planner cannot promise a shape the validator refuses.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	afterSubmitPlan,
	type FormLinkCommitPlan,
	planFormLinkAdd,
	planFormLinkMove,
	planFormLinkRemove,
	planFormLinkUpdate,
	planSetFallback,
} from "@/lib/doc/formLinkMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, FormLink } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const ELSE = testUuid("lnk-else");

interface Spec {
	uuid: string;
	condition?: string;
	target: FormLink["target"];
	datums?: Array<{ name: string; xpath: string }>;
}

const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;

/**
 * Intake (patient) → [Source (registration: it creates the case a Visit
 * link carries)]; Care (patient) → [Visit (followup), Note (survey)].
 * `postSubmit` is stored only when a test says so.
 */
function fixture(
	links: Spec[],
	opts: { postSubmit?: "app_home" | "module" | "previous" } = {},
): BlueprintDoc {
	return buildDoc({
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
		],
	});
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
const otherwise = (
	uuid = "lnk-else",
	target: FormLink["target"] = toCare,
): Spec => ({
	uuid,
	target,
});

/** Replay an ok plan through the reducers and the gate; return the doc. */
function commit(doc: BlueprintDoc, plan: FormLinkCommitPlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`refused: ${JSON.stringify(plan.reason)}`);
	const verdict = mutationCommitVerdict(
		doc,
		[...plan.mutations],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) {
		throw new Error(
			`gate refused: ${verdict.findings.map((e) => e.code).join(", ")}`,
		);
	}
	return produce(doc, (draft) => {
		applyMutations(draft, [...plan.mutations]);
	});
}

const order = (doc: BlueprintDoc) =>
	doc.forms[SOURCE]?.formLinks?.map((link) => link.uuid) ?? [];

const newLink = (uuid: string, condition?: string): FormLink => ({
	uuid: testUuid(uuid),
	...(condition !== undefined && { condition: xp(condition) }),
	target: toNote,
});

describe("afterSubmitPlan", () => {
	it("reads the form-type default when nothing is stored and no links exist", () => {
		const plan = afterSubmitPlan(fixture([]), SOURCE);
		expect(plan).toMatchObject({
			links: [],
			conditional: [],
			elseLink: undefined,
			fallback: {
				kind: "post-submit",
				destination: "app_home",
				explicit: false,
			},
			fallbackMustBeExplicit: false,
		});
	});

	it("names the terminal unconditional link as the otherwise", () => {
		const plan = afterSubmitPlan(
			fixture([cond("lnk-1", "1 = 1"), otherwise()]),
			SOURCE,
		);
		expect(plan?.conditional.map((l) => l.uuid)).toEqual([L1]);
		expect(plan?.elseLink?.uuid).toBe(ELSE);
		expect(plan?.fallback).toMatchObject({ kind: "else-link" });
		expect(plan?.fallbackMustBeExplicit).toBe(false);
	});

	it("requires an explicit destination under conditional-only links", () => {
		const unset = afterSubmitPlan(fixture([cond("lnk-1", "1 = 1")]), SOURCE);
		expect(unset?.fallbackMustBeExplicit).toBe(true);
		expect(unset?.fallback).toMatchObject({ explicit: false });
		const set = afterSubmitPlan(
			fixture([cond("lnk-1", "1 = 1")], { postSubmit: "module" }),
			SOURCE,
		);
		expect(set?.fallback).toMatchObject({
			destination: "module",
			explicit: true,
		});
	});

	it("treats a condition that prints to empty XPath as unconditional", () => {
		const plan = afterSubmitPlan(fixture([cond("lnk-1", "")]), SOURCE);
		expect(plan?.conditional).toEqual([]);
		expect(plan?.elseLink?.uuid).toBe(L1);
	});

	it("is undefined for a missing form", () => {
		expect(afterSubmitPlan(fixture([]), testUuid("ghost"))).toBeUndefined();
	});
});

describe("planFormLinkAdd", () => {
	it("appends a conditional link and pins the fallback when it is the first with no otherwise", () => {
		const doc = fixture([]);
		const plan = planFormLinkAdd(doc, SOURCE, newLink("lnk-1", "1 = 1"));
		expect(plan).toMatchObject({ ok: true, pinsFallback: "app_home" });
		if (!plan.ok) return;
		expect(plan.mutations.map((m) => m.kind)).toEqual([
			"addFormLink",
			"updateForm",
		]);
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.postSubmit).toBe("app_home");
		expect(order(next)).toEqual([L1]);
	});

	it("does not pin when the form already stores a destination or has an otherwise", () => {
		const stored = planFormLinkAdd(
			fixture([], { postSubmit: "module" }),
			SOURCE,
			newLink("lnk-1", "1 = 1"),
		);
		expect(stored).toMatchObject({ ok: true });
		expect(stored.ok && stored.pinsFallback).toBeUndefined();
		const withElse = fixture([otherwise()]);
		const plan = planFormLinkAdd(withElse, SOURCE, newLink("lnk-1", "1 = 1"));
		expect(plan.ok && plan.pinsFallback).toBeUndefined();
		// ...and the conditional link lands ABOVE the otherwise by default.
		expect(order(commit(withElse, plan))).toEqual([L1, ELSE]);
	});

	it("honours an explicit anchor and refuses one after the otherwise", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), otherwise()], {
			postSubmit: "app_home",
		});
		const first = planFormLinkAdd(doc, SOURCE, newLink("lnk-2", "2 = 2"), null);
		expect(order(commit(doc, first))).toEqual([L2, L1, ELSE]);
		const afterFirst = planFormLinkAdd(
			doc,
			SOURCE,
			newLink("lnk-2", "2 = 2"),
			L1,
		);
		expect(order(commit(doc, afterFirst))).toEqual([L1, L2, ELSE]);
		expect(
			planFormLinkAdd(doc, SOURCE, newLink("lnk-2", "2 = 2"), ELSE),
		).toEqual({
			ok: false,
			reason: { kind: "after-else", elseUuid: ELSE },
		});
	});

	it("lands an unconditional link last and refuses a second otherwise", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "app_home" });
		const plan = planFormLinkAdd(doc, SOURCE, newLink("lnk-else"));
		expect(order(commit(doc, plan))).toEqual([L1, ELSE]);
		expect(planFormLinkAdd(doc, SOURCE, newLink("lnk-else"), null)).toEqual({
			ok: false,
			reason: { kind: "else-not-last", blockingUuids: [L1] },
		});
		const withElse = commit(doc, plan);
		expect(planFormLinkAdd(withElse, SOURCE, newLink("lnk-3"))).toEqual({
			ok: false,
			reason: { kind: "else-exists", elseUuid: ELSE },
		});
	});

	it("refuses a duplicate uuid, a self target, a cycle, and a missing target", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "app_home" });
		expect(planFormLinkAdd(doc, SOURCE, newLink("lnk-1", "2 = 2"))).toEqual({
			ok: false,
			reason: { kind: "duplicate-uuid", uuid: L1 },
		});
		expect(
			planFormLinkAdd(doc, SOURCE, {
				uuid: L2,
				condition: xp("2 = 2"),
				target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
			}),
		).toEqual({ ok: false, reason: { kind: "self-target" } });
		// Note links back to Source; Source → Note would loop.
		const looped = produce(doc, (draft) => {
			const note = draft.forms[NOTE];
			if (note === undefined) throw new Error("fixture");
			note.formLinks = [
				{
					uuid: testUuid("lnk-back"),
					target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
				},
			];
		});
		expect(planFormLinkAdd(looped, SOURCE, newLink("lnk-2", "2 = 2"))).toEqual({
			ok: false,
			reason: { kind: "cycle", chain: [NOTE, SOURCE] },
		});
		expect(
			planFormLinkAdd(doc, SOURCE, {
				uuid: L2,
				condition: xp("2 = 2"),
				target: { type: "module", moduleUuid: testUuid("ghost") },
			}),
		).toEqual({ ok: false, reason: { kind: "target-not-found" } });
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

	it("writes only the changed slots and clears with null", () => {
		// Visit needs a case: the registration carries the one it creates, or
		// the link names one by hand.
		const doc = fixture([cond("lnk-1", "1 = 1", toVisit), otherwise()], {
			postSubmit: "app_home",
		});
		const current = base(doc, "lnk-1");
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{
				...current,
				condition: xp("2 = 2"),
				datums: [{ name: "case_id", xpath: xp("'x'") }],
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
					condition: xp("2 = 2"),
					datums: [{ name: "case_id", xpath: xp("'x'") }],
				},
			},
		]);
		const next = commit(doc, {
			...plan,
			mutations: [plan.mutations[0] as never],
		});
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
		const doc = fixture(
			[
				{
					uuid: "lnk-1",
					condition: "1 = 1",
					target: toVisit,
					datums: [{ name: "case_id", xpath: "'x'" }],
				},
			],
			{ postSubmit: "app_home" },
		);
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
	});

	it("is a no-op plan when nothing changed, whatever the key order", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "app_home" });
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
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "app_home" });
		const opened = base(doc, "lnk-1");
		const peerEdited = produce(doc, (draft) => {
			const link = draft.forms[SOURCE]?.formLinks?.[0];
			if (link === undefined) throw new Error("fixture");
			link.condition = xp("9 = 9");
		});
		expect(
			planFormLinkUpdate(
				peerEdited,
				SOURCE,
				{ ...opened, condition: xp("2 = 2") },
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
				datums: [{ name: "case_id", xpath: xp("'p'") }],
			},
			opened,
		);
		expect(retarget.ok && retarget.mutations[0]).toMatchObject({
			patch: { target: toVisit },
		});
		expect(
			planFormLinkUpdate(
				fixture([]),
				SOURCE,
				{ ...opened, condition: xp("2 = 2") },
				opened,
			),
		).toEqual({ ok: false, reason: { kind: "link-not-found", uuid: L1 } });
	});

	it("refuses making a link unconditional unless it is last, and pins when the otherwise turns conditional", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), otherwise()]);
		const first = base(doc, "lnk-1");
		expect(
			planFormLinkUpdate(
				doc,
				SOURCE,
				{ ...first, condition: undefined },
				first,
			),
		).toEqual({
			ok: false,
			reason: { kind: "else-not-last", blockingUuids: [ELSE] },
		});
		const elseLink = base(doc, "lnk-else");
		const plan = planFormLinkUpdate(
			doc,
			SOURCE,
			{ ...elseLink, condition: xp("2 = 2") },
			elseLink,
		);
		expect(plan).toMatchObject({ ok: true, pinsFallback: "app_home" });
		const next = commit(doc, plan);
		expect(next.forms[SOURCE]?.postSubmit).toBe("app_home");
	});

	it("refuses a retarget that would loop or point at itself", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "app_home" });
		const current = base(doc, "lnk-1");
		expect(
			planFormLinkUpdate(
				doc,
				SOURCE,
				{
					...current,
					target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
				},
				current,
			),
		).toEqual({ ok: false, reason: { kind: "self-target" } });
	});
});

describe("planFormLinkRemove", () => {
	it("removes a link, pinning the fallback when the otherwise goes and conditional links remain", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), otherwise()]);
		const plan = planFormLinkRemove(doc, SOURCE, ELSE);
		expect(plan).toMatchObject({ ok: true, pinsFallback: "app_home" });
		const next = commit(doc, plan);
		expect(order(next)).toEqual([L1]);
		expect(next.forms[SOURCE]?.postSubmit).toBe("app_home");
		// Removing the last link needs no pin (no links at all).
		const last = planFormLinkRemove(next, SOURCE, L1);
		expect(last.ok && last.pinsFallback).toBeUndefined();
		expect(commit(next, last).forms[SOURCE]?.formLinks).toBeUndefined();
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
		fixture([cond("lnk-1", "1 = 1"), cond("lnk-2", "2 = 2"), otherwise()], {
			postSubmit: "app_home",
		});

	it("moves by anchor and replays to the same order", () => {
		const plan = planFormLinkMove(doc(), SOURCE, L2, 0);
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: L2, after: null },
		]);
		expect(order(commit(doc(), plan))).toEqual([L2, L1, ELSE]);
		const back = planFormLinkMove(doc(), SOURCE, L1, 1);
		expect(back.ok && back.mutations).toEqual([
			{ kind: "moveFormLink", formUuid: SOURCE, uuid: L1, after: L2 },
		]);
	});

	it("is a no-op plan at the current position", () => {
		expect(planFormLinkMove(doc(), SOURCE, L1, 0)).toEqual({
			ok: true,
			mutations: [],
		});
	});

	it("refuses a conditional link below the otherwise and the otherwise above one", () => {
		expect(planFormLinkMove(doc(), SOURCE, L1, 2)).toEqual({
			ok: false,
			reason: { kind: "after-else", elseUuid: ELSE },
		});
		expect(planFormLinkMove(doc(), SOURCE, ELSE, 0)).toEqual({
			ok: false,
			reason: { kind: "else-not-last", blockingUuids: [L1, L2] },
		});
	});
});

describe("planSetFallback", () => {
	it("stores a built-in destination explicitly whenever links exist", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")], { postSubmit: "module" });
		const plan = planSetFallback(doc, SOURCE, "app_home");
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "updateForm", uuid: SOURCE, patch: { postSubmit: "app_home" } },
		]);
		expect(commit(doc, plan).forms[SOURCE]?.postSubmit).toBe("app_home");
	});

	it("uses the null-when-default shorthand only on a form without links", () => {
		const plain = fixture([], { postSubmit: "module" });
		const plan = planSetFallback(plain, SOURCE, "app_home");
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "updateForm", uuid: SOURCE, patch: { postSubmit: null } },
		]);
		expect(commit(plain, plan).forms[SOURCE]?.postSubmit).toBeUndefined();
		expect(planSetFallback(fixture([]), SOURCE, "app_home")).toEqual({
			ok: true,
			mutations: [],
		});
	});

	it("removes the otherwise link when a built-in destination is chosen", () => {
		const doc = fixture([cond("lnk-1", "1 = 1"), otherwise()]);
		const plan = planSetFallback(doc, SOURCE, "previous");
		expect(plan.ok && plan.mutations).toEqual([
			{ kind: "removeFormLink", formUuid: SOURCE, uuid: ELSE },
			{ kind: "updateForm", uuid: SOURCE, patch: { postSubmit: "previous" } },
		]);
		const next = commit(doc, plan);
		expect(order(next)).toEqual([L1]);
		expect(next.forms[SOURCE]?.postSubmit).toBe("previous");
	});

	it("refuses an otherwise link whose predeclared uuid is already a link", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		expect(
			planSetFallback(doc, SOURCE, {
				kind: "else-link",
				target: toCare,
				uuid: L1,
			}),
		).toEqual({ ok: false, reason: { kind: "duplicate-uuid", uuid: L1 } });
	});

	it("appends an otherwise link, and refuses a second one", () => {
		const doc = fixture([cond("lnk-1", "1 = 1")]);
		const plan = planSetFallback(doc, SOURCE, {
			kind: "else-link",
			target: toCare,
			uuid: ELSE,
		});
		expect(plan.ok && plan.mutations).toEqual([
			{
				kind: "addFormLink",
				formUuid: SOURCE,
				link: { uuid: ELSE, target: toCare },
			},
		]);
		const next = commit(doc, plan);
		expect(order(next)).toEqual([L1, ELSE]);
		expect(
			planSetFallback(next, SOURCE, { kind: "else-link", target: toCare }),
		).toEqual({
			ok: false,
			reason: { kind: "else-exists", elseUuid: ELSE },
		});
	});

	it("mints a uuid for the otherwise link when none is given", () => {
		const plan = planSetFallback(fixture([]), SOURCE, {
			kind: "else-link",
			target: toCare,
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const added = plan.mutations[0];
		expect(added?.kind).toBe("addFormLink");
		if (added?.kind !== "addFormLink") return;
		expect(added.link.uuid).toMatch(/^[0-9a-f-]{36}$/);
	});
});
