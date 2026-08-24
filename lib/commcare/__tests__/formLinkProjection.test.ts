/**
 * The after-submit link projection (`formLinkProjection.ts`): exclusive
 * guards, HQ's frame-children algorithm, datum matching, the `previous`
 * frame, and the totality predicates the validator asks before projecting.
 *
 * The byte oracle for the frame shapes is CommCare HQ's own suite fixture
 * `corehq/apps/app_manager/tests/data/form_workflow/form_link_multiple.xml`
 * (a frog-registration form linking to a followup and to another
 * registration in a second module), reproduced here as `frogDoc`.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import {
	entryFrameDatums,
	type FrameChild,
	type FrameDatum,
	formFrameChildren,
	formLinkActionsBuildable,
	formLinkExpressionProjectable,
	formLinkProjectionContext,
	formLinksProjectable,
	matchFrameToManual,
	matchFrameToSource,
	moduleCaseTypeForActions,
	ownCaseSessionRef,
	planFormLinkGuards,
	previousFrameChildren,
	projectFormLinks,
	sessionDataRef,
	targetFrameChildren,
	targetSelectionDatums,
} from "@/lib/commcare/formLinkProjection";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-reg");
const VISIT = testUuid("frm-visit");
const REGISTER_AGAIN = testUuid("frm-reg2");
const LINK_VISIT = testUuid("lnk-visit");
const LINK_REGISTER = testUuid("lnk-reg");

const nameWriter = () =>
	f({
		kind: "text",
		id: "case_name",
		label: proseText("Name"),
		caseWrite: { caseType: "frog", property: "case_name" },
	});

/** HQ's `form_link_multiple.xml` scenario in Nova's vocabulary. */
function frogDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Frogs",
		caseTypes: [
			{
				name: "frog",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "frog",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-reg",
						name: "Register frog",
						type: "registration",
						postSubmit: "app_home",
						formLinks: [
							{
								uuid: "lnk-visit",
								condition: "a = 1",
								target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
							},
							{
								uuid: "lnk-reg",
								condition: "a = 2",
								target: {
									type: "form",
									moduleUuid: CARE,
									formUuid: REGISTER_AGAIN,
								},
							},
						],
						fields: [nameWriter()],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Frog care",
				caseType: "frog",
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
								caseWrite: { caseType: "frog", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-reg2",
						name: "Register another",
						type: "registration",
						fields: [nameWriter()],
					},
				],
			},
		],
	});
}

/** Strip the render closure so frame datums compare structurally. */
function shape(child: FrameChild) {
	return child.type === "command"
		? child
		: {
				type: "datum" as const,
				id: child.datum.id,
				requiresSelection: child.datum.requiresSelection,
				...(child.datum.caseType !== undefined && {
					caseType: child.datum.caseType,
				}),
				...(child.datum.function !== undefined && {
					function: child.datum.function,
				}),
			};
}

const datum = (
	id: string,
	requiresSelection: boolean,
	caseType?: string,
	fn?: string,
): FrameDatum => ({
	id,
	requiresSelection,
	...(caseType !== undefined && { caseType }),
	...(fn !== undefined && { function: fn }),
});

describe("planFormLinkGuards", () => {
	const L = (uuid: string, condition?: string) => ({
		uuid: testUuid(uuid),
		...(condition !== undefined && { condition }),
	});

	it("leaves the first guard bare, byte-identical to HQ's first frame", () => {
		expect(planFormLinkGuards([L("a", "x = 1")])).toEqual({
			links: [{ uuid: testUuid("a"), guard: "x = 1" }],
			fallback: { kind: "guarded", guard: "not(x = 1)" },
		});
	});

	it("makes later guards exclusive by negating every conditional prior", () => {
		const plan = planFormLinkGuards([
			L("a", "x = 1"),
			L("b", "y = 1 or z = 1"),
			L("c", "w = 1"),
		]);
		expect(plan.links.map((link) => link.guard)).toEqual([
			"x = 1",
			// The positive operand is parenthesized so a top-level `or`
			// cannot leak past the conjunction.
			"(y = 1 or z = 1) and not(x = 1)",
			"(w = 1) and not(x = 1) and not(y = 1 or z = 1)",
		]);
		// The fallback negates the EMITTED guards — HQ's literal
		// `' and '.join(f'not({xpath})')` over what Nova sends it.
		expect(plan.fallback).toEqual({
			kind: "guarded",
			guard:
				"not(x = 1) and not((y = 1 or z = 1) and not(x = 1)) and not((w = 1) and not(x = 1) and not(y = 1 or z = 1))",
		});
	});

	it("treats a terminal unconditional link as the exhaustive else", () => {
		const plan = planFormLinkGuards([L("a", "x = 1"), L("b")]);
		expect(plan.links).toEqual([
			{ uuid: testUuid("a"), guard: "x = 1" },
			{ uuid: testUuid("b"), guard: "not(x = 1)" },
		]);
		expect(plan.fallback).toEqual({ kind: "suppressed-by-else" });
	});

	it("emits no guard and no fallback for a sole unconditional link", () => {
		expect(planFormLinkGuards([L("a")])).toEqual({
			links: [{ uuid: testUuid("a") }],
			fallback: { kind: "none" },
		});
	});

	it("stays total over an unconditional link that is not last", () => {
		// The validator refuses this document (FORM_LINK_UNREACHABLE); the
		// plan still answers so every consumer stays total.
		const plan = planFormLinkGuards([L("a"), L("b", "x = 1")]);
		expect(plan.links).toEqual([
			{ uuid: testUuid("a") },
			{ uuid: testUuid("b"), guard: "x = 1" },
		]);
		expect(plan.fallback).toEqual({ kind: "guarded", guard: "not(x = 1)" });
	});

	it("answers the empty list with no links and no fallback", () => {
		expect(planFormLinkGuards([])).toEqual({
			links: [],
			fallback: { kind: "none" },
		});
	});
});

describe("frame children (HQ `get_frame_children`)", () => {
	it("a module target is the module command alone", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			targetFrameChildren(doc, ctx, { type: "module", moduleUuid: CARE }),
		).toEqual([{ type: "command", id: "m1" }]);
	});

	it("a form target is m, the module's common datum prefix, m-f, then the rest", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		// Frog care holds a followup ([case_id]) and a registration
		// ([case_id_new_frog_0]): no common prefix, so each form's datums
		// follow its own command.
		expect(formFrameChildren(doc, ctx, CARE, VISIT).map(shape)).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
			{
				type: "datum",
				id: "case_id",
				requiresSelection: true,
				caseType: "frog",
			},
		]);
		expect(
			formFrameChildren(doc, ctx, CARE, REGISTER_AGAIN).map(shape),
		).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f1" },
			{
				type: "datum",
				id: "case_id_new_frog_0",
				requiresSelection: false,
				caseType: "frog",
				function: "uuid()",
			},
		]);
	});

	it("hoists the shared selection datum ahead of the form command in a case-first module", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-p",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-a",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "a", label: proseText("A") })],
						},
						{
							uuid: "frm-b",
							name: "Close",
							type: "close",
							fields: [f({ kind: "text", id: "b", label: proseText("B") })],
						},
					],
				},
			],
		});
		const ctx = formLinkProjectionContext(doc);
		expect(
			formFrameChildren(doc, ctx, testUuid("mod-p"), testUuid("frm-b")).map(
				shape,
			),
		).toEqual([
			{ type: "command", id: "m0" },
			{
				type: "datum",
				id: "case_id",
				requiresSelection: true,
				caseType: "patient",
			},
			{ type: "command", id: "m0-f1" },
		]);
	});

	it("names the selection datums a target needs", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			targetSelectionDatums(doc, ctx, {
				type: "form",
				moduleUuid: CARE,
				formUuid: VISIT,
			}).map((d) => d.id),
		).toEqual(["case_id"]);
		expect(
			targetSelectionDatums(doc, ctx, {
				type: "form",
				moduleUuid: CARE,
				formUuid: REGISTER_AGAIN,
			}),
		).toEqual([]);
	});

	it("reads a registration form's entry datums with their case type", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			entryFrameDatums(doc, ctx, INTAKE, REGISTER).map((d) => ({
				id: d.id,
				requiresSelection: d.requiresSelection,
				caseType: d.caseType,
				function: d.function,
			})),
		).toEqual([
			{
				id: "case_id_new_frog_0",
				requiresSelection: false,
				caseType: "frog",
				function: "uuid()",
			},
		]);
	});
});

describe("datum matching", () => {
	const target: FrameChild[] = [
		{ type: "command", id: "m1" },
		{ type: "command", id: "m1-f0" },
		{ type: "datum", datum: datum("case_id", true, "frog") },
	];

	it("keeps the target id when the source carries the same id and type", () => {
		const match = matchFrameToSource(target, [datum("case_id", true, "frog")]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([{ id: "case_id", sourceId: "case_id" }]);
		expect(match.children).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
			{ type: "datum", id: "case_id", value: sessionDataRef("case_id") },
		]);
	});

	it("carries the source id when the same type lives under another id (HQ `_find_best_match`)", () => {
		const match = matchFrameToSource(target, [
			datum("case_id_new_frog_0", false, "frog", "uuid()"),
		]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([
			{ id: "case_id", sourceId: "case_id_new_frog_0" },
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_0"),
		});
	});

	it("takes the FIRST source datum of the type in source order", () => {
		const match = matchFrameToSource(target, [
			datum("case_id_new_frog_0", false, "frog", "uuid()"),
			datum("case_id", true, "frog"),
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_0"),
		});
	});

	it("skips root-module placeholder datums when choosing an automatic source", () => {
		const match = matchFrameToSource(target, [
			{
				...datum("case_id_new_frog_0", false, "frog", "uuid()"),
				fromParentModule: true,
			},
			datum("case_id_new_frog_1", false, "frog", "uuid()"),
		]);
		expect(match.unmatched).toEqual([]);
		expect(match.matched).toEqual([
			{ id: "case_id", sourceId: "case_id_new_frog_1" },
		]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id",
			value: sessionDataRef("case_id_new_frog_1"),
		});
	});

	it("reports a selection datum nothing in the source satisfies", () => {
		// A type-less source datum never matches, and a different type
		// never matches: Core would open the target with an empty case id.
		const match = matchFrameToSource(target, [
			datum("case_id", true),
			datum("case_id", true, "toad"),
		]);
		expect(match.unmatched.map((d) => d.id)).toEqual(["case_id"]);
	});

	it("carries a function datum as its function, never as a session ref", () => {
		const match = matchFrameToSource(
			[
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f1" },
				{
					type: "datum",
					datum: datum("case_id_new_frog_0", false, "frog", "uuid()"),
				},
			],
			[datum("case_id", true, "frog")],
		);
		expect(match.unmatched).toEqual([]);
		expect(match.children[2]).toEqual({
			type: "datum",
			id: "case_id_new_frog_0",
			value: "uuid()",
		});
	});

	it("manual values land on the target datum they name and report the rest", () => {
		const match = matchFrameToManual(
			[
				{ type: "command", id: "m1" },
				{ type: "datum", datum: datum("parent_id", true, "clinic") },
				{ type: "command", id: "m1-f0" },
				{ type: "datum", datum: datum("case_id", true, "frog") },
				{
					type: "datum",
					datum: datum("case_id_new_visit_1", false, "visit", "uuid()"),
				},
			],
			[
				{ name: "case_id", xpath: "'frog-7'" },
				{ name: "nothing_reads_this", xpath: "'x'" },
			],
			new Set(),
		);
		expect(match.children).toEqual([
			{ type: "command", id: "m1" },
			// An unnamed selection datum is still carried by its self
			// reference so the frame is total — and reported as `missing`.
			{ type: "datum", id: "parent_id", value: sessionDataRef("parent_id") },
			{ type: "command", id: "m1-f0" },
			{ type: "datum", id: "case_id", value: "'frog-7'" },
			// A function datum nobody names keeps its function.
			{ type: "datum", id: "case_id_new_visit_1", value: "uuid()" },
		]);
		expect(match.missing.map((d) => d.id)).toEqual(["parent_id"]);
		expect(match.unused).toEqual(["nothing_reads_this"]);
	});
});

describe("previousFrameChildren (HQ `previous_screen`)", () => {
	it("pops the last child and keeps popping while the popped child was a non-selection datum", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		// Forms-first module: [m1, m1-f0, case_id] → pop case_id → m1-f0 is
		// a command, stop.
		expect(previousFrameChildren(doc, ctx, CARE, VISIT)).toEqual([
			{ type: "command", id: "m1" },
			{ type: "command", id: "m1-f0" },
		]);
		// [m1, m1-f1, case_id_new_frog_0] → the popped child is a function
		// datum, so HQ pops again → the command goes too → [m1]. A
		// registration form's "previous" is its module menu.
		expect(previousFrameChildren(doc, ctx, CARE, REGISTER_AGAIN)).toEqual([
			{ type: "command", id: "m1" },
		]);
	});

	it("keeps the hoisted selection datum in a case-first module", () => {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-p",
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-a",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "a", label: proseText("A") })],
						},
					],
				},
			],
		});
		const ctx = formLinkProjectionContext(doc);
		// [m0, case_id, m0-f0] → pop m0-f0 → case_id is a selection, keep.
		expect(
			previousFrameChildren(doc, ctx, testUuid("mod-p"), testUuid("frm-a")),
		).toEqual([
			{ type: "command", id: "m0" },
			{ type: "datum", id: "case_id", value: sessionDataRef("case_id") },
		]);
	});
});

describe("projectFormLinks", () => {
	it("reproduces HQ's form_link_multiple.xml frames with exclusive guards", () => {
		const doc = frogDoc();
		const projected = projectFormLinks(
			doc,
			formLinkProjectionContext(doc),
			REGISTER,
		);
		expect(projected).toBeDefined();
		if (projected === undefined) return;
		expect(projected.links.map((link) => link.guard)).toEqual([
			"a = 1",
			"(a = 2) and not(a = 1)",
		]);
		expect(projected.links[0]).toMatchObject({
			uuid: LINK_VISIT,
			children: [
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f0" },
				{
					type: "datum",
					id: "case_id",
					value: sessionDataRef("case_id_new_frog_0"),
				},
			],
			datums: [],
			unmatched: [],
			missing: [],
			unused: [],
		});
		expect(projected.links[1]).toMatchObject({
			uuid: LINK_REGISTER,
			children: [
				{ type: "command", id: "m1" },
				{ type: "command", id: "m1-f1" },
				{ type: "datum", id: "case_id_new_frog_0", value: "uuid()" },
			],
		});
		expect(projected.fallback).toEqual({
			kind: "guarded",
			guard: "not(a = 1) and not((a = 2) and not(a = 1))",
		});
	});

	it("anchors a registration form's case reads at the case it created", () => {
		// After a registration form closes its case EXISTS and the entry's
		// create datum names it, so `#frog/mood` walks casedb from
		// `case_id_new_frog_0` and `#frog/case_id` IS that datum.
		const doc = structuredClone(frogDoc());
		const reg = doc.forms[REGISTER];
		if (reg?.formLinks?.[0] === undefined) throw new Error("fixture");
		reg.formLinks = [
			{
				...reg.formLinks[0],
				condition: xp("#frog/mood = 'happy' and #frog/case_id != ''"),
			},
		];
		const projected = projectFormLinks(
			doc,
			formLinkProjectionContext(doc),
			REGISTER,
		);
		const created = sessionDataRef("case_id_new_frog_0");
		expect(projected?.links[0]?.guard).toBe(
			`instance('casedb')/casedb/case[@case_id = ${created}]/mood = 'happy' and ${created} != ''`,
		);
	});

	it("anchors a case-loading form's case reads at the selected case, and reads case_id as the attribute", () => {
		const doc = structuredClone(frogDoc());
		const visit = doc.forms[VISIT];
		if (visit === undefined) throw new Error("fixture");
		visit.formLinks = [
			{
				uuid: testUuid("lnk-back"),
				condition: xp("#frog/case_id != ''"),
				target: { type: "module", moduleUuid: INTAKE },
			},
			{
				uuid: testUuid("lnk-else"),
				target: { type: "module", moduleUuid: CARE },
			},
		];
		const projected = projectFormLinks(
			doc,
			formLinkProjectionContext(doc),
			VISIT,
		);
		expect(projected?.links[0]?.guard).toBe(
			`${sessionDataRef("case_id")} != ''`,
		);
	});

	it("returns undefined for a form without links", () => {
		const doc = frogDoc();
		expect(
			projectFormLinks(doc, formLinkProjectionContext(doc), VISIT),
		).toBeUndefined();
	});
});

describe("ownCaseSessionRef", () => {
	it("is the selection datum on a case-loading form and the create datum on a registration form", () => {
		const doc = frogDoc();
		const ctx = formLinkProjectionContext(doc);
		expect(
			ownCaseSessionRef(
				doc,
				CARE,
				"followup",
				entryFrameDatums(doc, ctx, CARE, VISIT),
			),
		).toBe(sessionDataRef("case_id"));
		expect(
			ownCaseSessionRef(
				doc,
				INTAKE,
				"registration",
				entryFrameDatums(doc, ctx, INTAKE, REGISTER),
			),
		).toBe(sessionDataRef("case_id_new_frog_0"));
	});

	it("is undefined for a survey, which carries no case", () => {
		const doc = structuredClone(frogDoc());
		const mod = doc.modules[INTAKE];
		const reg = doc.forms[REGISTER];
		if (mod === undefined || reg === undefined) throw new Error("fixture");
		mod.caseType = undefined;
		mod.caseListConfig = undefined;
		reg.type = "survey";
		reg.formLinks = undefined;
		for (const uuid of doc.fieldOrder[REGISTER] ?? []) {
			delete (doc.fields[uuid] as { caseWrite?: unknown }).caseWrite;
		}
		const ctx = formLinkProjectionContext(doc);
		expect(
			ownCaseSessionRef(
				doc,
				INTAKE,
				"survey",
				entryFrameDatums(doc, ctx, INTAKE, REGISTER),
			),
		).toBeUndefined();
	});
});

describe("totality predicates", () => {
	it("formLinkActionsBuildable says no when a module the frame reads is outside the sequence or has a malformed case type", () => {
		const doc = frogDoc();
		const links = doc.forms[REGISTER]?.formLinks ?? [];
		expect(formLinkActionsBuildable(doc, REGISTER, links)).toBe(true);

		const badType = structuredClone(doc);
		const care = badType.modules[CARE];
		if (care === undefined) throw new Error("fixture");
		care.caseType = "frog case";
		expect(formLinkActionsBuildable(badType, REGISTER, links)).toBe(false);
		expect(() =>
			projectFormLinks(badType, formLinkProjectionContext(badType), REGISTER),
		).toThrow();

		const unsequenced = structuredClone(doc);
		unsequenced.moduleOrder = unsequenced.moduleOrder.filter(
			(uuid) => uuid !== CARE,
		);
		expect(formLinkActionsBuildable(unsequenced, REGISTER, links)).toBe(false);
	});

	it("moduleCaseTypeForActions mirrors the expander's case-activity gate", () => {
		const doc = buildDoc({
			appName: "Gate",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "mod-survey",
					name: "Surveys",
					caseType: "patient",
					forms: [
						{
							name: "S",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
				{
					uuid: "mod-viewer",
					name: "Viewer",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		});
		expect(moduleCaseTypeForActions(doc, testUuid("mod-survey"))).toBe("");
		expect(moduleCaseTypeForActions(doc, testUuid("mod-viewer"))).toBe(
			"patient",
		);
	});

	it("formLinkExpressionProjectable refuses form-local reads and raw #case/", () => {
		const doc = frogDoc();
		expect(formLinkExpressionProjectable(doc, xp("1 = 1"))).toBe(true);
		expect(formLinkExpressionProjectable(doc, xp("#frog/mood = 'calm'"))).toBe(
			true,
		);
		expect(formLinkExpressionProjectable(doc, xp("#user/username = 'a'"))).toBe(
			true,
		);
		expect(formLinkExpressionProjectable(doc, xp("#form/x = 'a'"))).toBe(false);
		expect(formLinkExpressionProjectable(doc, xp("#case/mood = 'a'"))).toBe(
			false,
		);
		expect(
			formLinkExpressionProjectable(doc, {
				parts: [
					{ kind: "field-ref", uuid: testUuid("some-field") },
					{ kind: "text", text: " = 'a'" },
				],
			}),
		).toBe(false);
		expect(
			formLinkExpressionProjectable(doc, {
				parts: [
					{
						kind: "user-property-ref",
						userPropertyUuid: testUuid("missing-user-property"),
					},
				],
			}),
		).toBe(false);
	});

	it("formLinksProjectable covers conditions and datum expressions", () => {
		const doc = frogDoc();
		const target = { type: "module" as const, moduleUuid: CARE };
		expect(
			formLinksProjectable(doc, [
				{ uuid: testUuid("l"), condition: xp("1 = 1"), target },
			]),
		).toBe(true);
		expect(
			formLinksProjectable(doc, [
				{
					uuid: testUuid("l"),
					target,
					datums: [{ name: "case_id", xpath: xp("#form/x") }],
				},
			]),
		).toBe(false);
	});

	it("formLinkActionsBuildable says no when a form the frame reads has no buildable actions", () => {
		const doc = frogDoc();
		const links = doc.forms[REGISTER]?.formLinks ?? [];
		expect(formLinkActionsBuildable(doc, REGISTER, links)).toBe(true);
		// Strip the target module's registration form of its case_name
		// writer: the admission refuses it (CASE_CREATE_NAME_MISSING) and the
		// wire builder would throw on it.
		const broken = structuredClone(doc);
		const nameField = Object.values(broken.fields).find(
			(field) =>
				field.id === "case_name" &&
				(broken.fieldOrder[REGISTER_AGAIN] ?? []).includes(field.uuid),
		);
		if (nameField === undefined) throw new Error("fixture missing writer");
		delete (nameField as { caseWrite?: unknown }).caseWrite;
		expect(formLinkActionsBuildable(broken, REGISTER, links)).toBe(false);
	});

	it("formLinkActionsBuildable closes over a child module's structural-root forms", () => {
		const doc = frogDoc();
		const care = doc.modules[CARE];
		const visit = doc.forms[VISIT];
		if (care === undefined || visit === undefined) throw new Error("fixture");
		care.parentModuleUuid = INTAKE;
		const links = [
			{
				uuid: testUuid("lnk-child-self"),
				target: { type: "module" as const, moduleUuid: CARE },
			},
		];
		expect(formLinkActionsBuildable(doc, VISIT, links)).toBe(true);

		const broken = structuredClone(doc);
		const rootNameWriter = Object.values(broken.fields).find(
			(field) =>
				field.id === "case_name" &&
				(broken.fieldOrder[REGISTER] ?? []).includes(field.uuid),
		);
		if (rootNameWriter === undefined) throw new Error("fixture missing writer");
		delete (rootNameWriter as { caseWrite?: unknown }).caseWrite;

		expect(formLinkActionsBuildable(broken, VISIT, links)).toBe(false);
	});
});
