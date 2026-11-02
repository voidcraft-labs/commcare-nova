/**
 * The one plan that turns a form's placements into the wire: HQ's basic or
 * advanced actions, the Save to Case blocks, the new cases' datums and the
 * blocks HQ's build appends. Catches an action HQ builds differently from
 * what the placement chose, a held path the plan does not write as held, a
 * change emitted twice or nowhere, and a datum the entry names that no
 * action allocates.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type AdvancedFormCaseWirePlan,
	type BasicFormCaseWirePlan,
	type FormCaseWirePlan,
	planFormCaseWire,
} from "@/lib/commcare/casePlacementPlan";
import { buildFormActions } from "@/lib/commcare/formActions";
import {
	entryDatumIds,
	formLinkProjectionContext,
} from "@/lib/commcare/formLinkProjection";
import { planPlacements } from "@/lib/commcare/placement";
import { runValidation } from "@/lib/commcare/validator/runner";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { eq } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import {
	advancedFixture,
	choice,
	chosen,
	HOUSEHOLDS,
} from "./advancedPlacementFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "./extensionCaseFixture";
import {
	childCreate,
	OP,
	OPT,
	OWN,
	own,
	ownCaseLink,
	placementFixture,
	read,
	U,
} from "./placementFixture";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";

/** The plan of a form its menu emits basic. */
function basicPlan(doc: BlueprintDoc, formUuid: Uuid): BasicFormCaseWirePlan {
	const plan = planFormCaseWire(doc, formUuid);
	if (plan.kind !== "basic")
		throw new Error("The form was planned as an advanced form.");
	return plan;
}

/** The plan of a form its menu emits advanced. */
function advancedPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AdvancedFormCaseWirePlan {
	const plan = planFormCaseWire(doc, formUuid);
	if (plan.kind !== "advanced")
		throw new Error("The form was planned as a basic form.");
	return plan;
}

const yes: Expression = {
	kind: "term",
	term: { kind: "choice", field: U("status"), options: [OPT("yes")] },
} as Expression;

describe("planFormCaseWire", () => {
	it("opens a registration's case under its condition, with its subcases and their datums", () => {
		const { doc, formUuid } = placementFixture("registration", {
			operations: (t) => [
				own({
					name: read("name"),
					writes: [{ property: "age", value: read("age") }],
				}),
				childCreate("kid", t, { condition: read("flag") }),
				childCreate("row", t, { repeat: "kids" }),
			],
			form: { openCondition: eq(read("status"), yes) },
		});
		const plan = basicPlan(doc, formUuid);
		expect(plan.actions.open_case.condition).toEqual({
			type: "if",
			question: "/data/status",
			answer: "yes",
			operator: "=",
			doc_type: "FormActionCondition",
		});
		expect(plan.actions.open_case.name_update.question_path).toBe(
			"/data/nova_trimmed_name",
		);
		expect(plan.actions.update_case.update).toEqual({
			age: { question_path: "/data/age", update_mode: "always" },
		});
		expect(plan.actions.close_case.condition.type).toBe("never");
		expect(
			plan.actions.subcases.map((subcase) => ({
				case_type: subcase.case_type,
				repeat_context: subcase.repeat_context,
				condition: subcase.condition.operator,
				relationship: subcase.relationship,
				reference_id: subcase.reference_id,
			})),
		).toEqual([
			{
				case_type: "kid",
				repeat_context: "",
				condition: "boolean_true",
				relationship: "child",
				reference_id: "",
			},
			{
				case_type: "kid",
				repeat_context: "/data/kids",
				condition: null,
				relationship: "child",
				reference_id: "",
			},
		]);
		expect(plan.datums).toEqual([
			{
				operationUuid: OWN,
				id: "case_id_new_patient_0",
				caseType: "patient",
				ref: { kind: "new-case" },
			},
			{
				operationUuid: OP("kid"),
				id: "case_id_new_kid_1",
				caseType: "kid",
				ref: { kind: "new-child-case", caseType: "kid" },
			},
		]);
		expect(
			plan.appendedNames.map(({ scope, name }) => `${scope.toXPath()}:${name}`),
		).toEqual(["/data:subcase_0", "/data/kids:case", "/data:case"]);
		expect(plan.saveToCase).toEqual([]);
	});

	it("updates a follow-up's case by key, through an index and only when changed", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own({
					writes: [
						{ property: "age", value: read("age"), onlyIfChanged: true },
						{
							property: "status",
							value: read("status"),
							via: [{ identifier: "parent" }],
						},
					],
				}),
			],
		});
		const { actions, datums } = basicPlan(doc, formUuid);
		expect(actions.update_case.update).toEqual({
			age: { question_path: "/data/age", update_mode: "edit" },
			"parent/status": { question_path: "/data/status", update_mode: "always" },
		});
		expect(actions.open_case.condition.type).toBe("never");
		expect(datums).toEqual([]);
	});

	it("closes a close form's case in its own action where Case Management states it", () => {
		const { doc, formUuid } = placementFixture("close", {
			operations: () => [own()],
			form: { closeCondition: read("flag") },
		});
		const { actions, saveToCase } = basicPlan(doc, formUuid);
		expect(actions.close_case.condition).toMatchObject({
			type: "if",
			question: "/data/flag",
			operator: "boolean_true",
		});
		expect(saveToCase).toEqual([]);
	});

	it("writes a close Case Management cannot state as its own block, and HQ's close never", () => {
		const { doc, formUuid } = placementFixture("close", {
			operations: () => [own()],
			form: { closeCondition: read("name") },
		});
		const { actions, saveToCase } = basicPlan(doc, formUuid);
		expect(actions.close_case.condition.type).toBe("never");
		expect(saveToCase).toEqual([
			{
				subject: { kind: "own-close" },
				scope: FormPath.root(),
				path: ["nova_operations", "nova_condition_close", "nova_close"],
				held: false,
			},
		]);
	});

	it("saves the worker's record in its own action", () => {
		const { doc, formUuid } = placementFixture("survey", {
			operations: () => [
				{
					uuid: OP("worker"),
					id: "worker",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: "age", value: read("age") }],
				} as CaseOperation,
			],
		});
		const plan = basicPlan(doc, formUuid);
		expect(plan.actions.usercase_update).toMatchObject({
			update: { age: { question_path: "/data/age", update_mode: "always" } },
			condition: { type: "always" },
		});
		expect(plan.appendedNames.map(({ name }) => name)).toEqual([
			"commcare_usercase",
		]);
	});

	it("writes a held Save to Case path verbatim", () => {
		const held = {
			kind: "save-to-case" as const,
			repeat: U("kids"),
			path: ["published_group", "published_block"] as [string, ...string[]],
		};
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				{
					uuid: OP("upd"),
					id: "upd",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					forEach: { repeat: U("kids") },
					writes: [{ property: "age", value: read("kid_age") }],
					placement: held,
				} as CaseOperation,
			],
		});
		expect(basicPlan(doc, formUuid).saveToCase).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("upd") },
				scope: FormPath.parse("/data/kids"),
				path: ["published_group", "published_block"],
				held: true,
			},
		]);
	});

	it("writes an extension child as a Save to Case block, with the basic children after it renumbered", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("ext", t, { links: [ownCaseLink(t, "extension")] }),
				childCreate("kid", t),
			],
		});
		const plan = basicPlan(doc, formUuid);
		// HQ's basic build ignores a subcase's relationship, so a basic subcase
		// holds a child create only: the child is subcase 0, not 1.
		expect(
			plan.actions.subcases.map((subcase) => [
				subcase.case_type,
				subcase.relationship,
				subcase.condition.type,
			]),
		).toEqual([["kid", "child", "always"]]);
		expect(plan.saveToCase).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("ext") },
				scope: FormPath.root(),
				path: ["nova_operations", "ext"],
				held: false,
			},
		]);
		expect(plan.datums.map((datum) => [datum.operationUuid, datum.id])).toEqual(
			[[OP("kid"), "case_id_new_kid_0"]],
		);
		expect(plan.appendedNames.map(({ name }) => name)).toEqual([
			"subcase_0",
			"case",
		]);
	});
});

const visitUpdate = (key: string, extra: Partial<CaseOperation> = {}) =>
	({
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "household",
		target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
		...extra,
	}) as CaseOperation;

/** A follow-up of the Members menu, chosen under a household: the own load,
 *  a write of the household, the worker's record and a visit. */
function closeMembers() {
	return advancedFixture({
		formType: "close",
		menu: "members",
		form: { closeCondition: eq(read("status"), choice("status", "yes")) },
		operations: () => [
			own({
				name: read("name"),
				owner: read("owner_q"),
				writes: [{ property: "age", value: read("age"), onlyIfChanged: true }],
			}),
			visitUpdate("household", {
				writes: [{ property: "visited", value: read("status") }],
			}),
			{
				uuid: OP("worker"),
				id: "worker",
				action: "update",
				caseType: "commcare-user",
				target: { kind: "worker-record" },
				writes: [{ property: "last", value: read("name") }],
			} as CaseOperation,
			{
				uuid: OP("visit"),
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("name"),
				links: [
					{
						identifier: "parent",
						targetType: "household",
						target: { kind: "expression", expr: chosen(HOUSEHOLDS) },
						relationship: "child",
					},
				],
			} as CaseOperation,
			{
				uuid: OP("kid"),
				id: "kid",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("kid_name"),
				forEach: { repeat: U("kids") },
				owner: { kind: "unowned" },
			} as CaseOperation,
		],
	});
}

/** A registration of the Households menu: its own case, a visit under it
 *  closed on an answer, and a visit per row of a repeat under that one. */
function registerHousehold() {
	return advancedFixture({
		formType: "registration",
		form: { openCondition: eq(read("status"), choice("status", "yes")) },
		operations: () => [
			own({ name: read("name") }),
			{
				uuid: OP("visit"),
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("name"),
				links: [
					{
						identifier: "parent",
						targetType: "household",
						target: { kind: "op", opUuid: OWN },
						relationship: "child",
					},
				],
			} as CaseOperation,
			{
				uuid: OP("done"),
				id: "done",
				action: "close",
				caseType: "visit",
				target: { kind: "op", opUuid: OP("visit") },
				condition: eq(read("status"), choice("status", "no")),
			} as CaseOperation,
			{
				uuid: OP("kid"),
				id: "kid",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name: read("kid_name"),
				forEach: { repeat: U("kids") },
				links: [
					{
						identifier: "parent",
						targetType: "visit",
						target: { kind: "op", opUuid: OP("visit") },
						relationship: "extension",
					},
				],
			} as CaseOperation,
		],
	});
}

const never = {
	type: "never",
	question: null,
	answer: null,
	operator: null,
	doc_type: "FormActionCondition",
};
const always = { ...never, type: "always" };
const noIndex = {
	doc_type: "CaseIndex",
	tag: "",
	reference_id: "parent",
	relationship: "child",
	relationship_question: "",
};

describe("planFormCaseWire, advanced", () => {
	it("loads the chain, the worker's record, and opens what the form creates", () => {
		const { doc, formUuid, moduleUuid } = closeMembers();
		const plan = advancedPlan(doc, formUuid);
		const loadBase = {
			doc_type: "LoadUpdateAction",
			preload: {},
			load_case_from_fixture: null,
			show_product_stock: false,
			product_program: "",
		};
		expect(plan.actions.load_update_cases).toEqual([
			{
				...loadBase,
				case_type: "household",
				case_tag: "load_household0",
				details_module: HOUSEHOLDS.replaceAll("-", ""),
				case_properties: {
					visited: { question_path: "/data/status", update_mode: "always" },
				},
				close_condition: never,
				case_index: noIndex,
				auto_select: null,
			},
			{
				...loadBase,
				case_type: "member",
				case_tag: "load_member1",
				details_module: moduleUuid.replaceAll("-", ""),
				// The rename is `name` (HQ maps it to `case_name`), read through the
				// trimmed sibling; the owner is `owner_id`.
				case_properties: {
					name: {
						question_path: "/data/nova_trimmed_name",
						update_mode: "always",
					},
					owner_id: { question_path: "/data/owner_q", update_mode: "always" },
					age: { question_path: "/data/age", update_mode: "edit" },
				},
				// The own close is the own load's.
				close_condition: {
					type: "if",
					question: "/data/status",
					answer: "yes",
					operator: "=",
					doc_type: "FormActionCondition",
				},
				case_index: {
					...noIndex,
					tag: "load_household0",
				},
				auto_select: null,
			},
			{
				...loadBase,
				case_type: "commcare-user",
				case_tag: "autoload_commcare_user2",
				details_module: null,
				case_properties: {
					last: { question_path: "/data/name", update_mode: "always" },
				},
				close_condition: never,
				case_index: noIndex,
				auto_select: {
					doc_type: "AutoSelectCase",
					mode: "usercase",
					value_source: "",
					value_key: "",
				},
			},
		]);
		expect(plan.actions.open_cases).toEqual([
			{
				doc_type: "AdvancedOpenCaseAction",
				case_type: "visit",
				case_tag: "open_visit_0",
				name_update: {
					question_path: "/data/nova_trimmed_name",
					update_mode: "always",
				},
				case_properties: {},
				repeat_context: "",
				case_indices: [{ ...noIndex, tag: "load_household0" }],
				open_condition: always,
				close_condition: never,
			},
			{
				doc_type: "AdvancedOpenCaseAction",
				case_type: "visit",
				case_tag: "open_visit_1",
				// An open action's name reads the question's trimmed sibling, as
				// a basic slot's does.
				name_update: {
					question_path: "/data/kids/nova_trimmed_kid_name",
					update_mode: "always",
				},
				// HQ's build would own an unindexed case by the worker, so an
				// unowned one names its generated node.
				case_properties: {
					owner_id: {
						question_path: "/data/kids/nova_owner_kid",
						update_mode: "always",
					},
				},
				repeat_context: "/data/kids",
				case_indices: [],
				open_condition: always,
				close_condition: never,
			},
		]);
		expect(
			plan.generated.map((node) => [
				node.operationUuid,
				node.scope.toXPath(),
				node.name,
				node.value,
			]),
		).toEqual([[OP("kid"), "/data/kids", "nova_owner_kid", "unowned"]]);
		expect(plan.saveToCase).toEqual([]);
		// Only the open action outside a repeat is given a datum.
		expect(plan.datums).toEqual([
			{
				operationUuid: OP("visit"),
				id: "case_id_new_visit_0",
				caseType: "visit",
				ref: { kind: "new-child-case", caseType: "visit" },
			},
		]);
		expect(
			plan.appendedNames.map(({ scope, name }) => `${scope.toXPath()}:${name}`),
		).toEqual([
			"/data:case_load_household0",
			"/data:case_load_member1",
			"/data:case_autoload_commcare_user2",
			"/data:case_open_visit_0",
			"/data/kids:case",
		]);
		expect(plan.loads.map((load) => load.tag)).toEqual([
			"load_household0",
			"load_member1",
			"autoload_commcare_user2",
		]);
		expect(() => buildFormActions(doc, formUuid)).toThrow(
			"This form is emitted as an advanced form; read its advanced actions.",
		);
	});

	it("opens a registration's case first, indexes each create by its parent's tag, and shares a close", () => {
		const { doc, formUuid } = registerHousehold();
		const plan = advancedPlan(doc, formUuid);
		expect(plan.actions.load_update_cases).toEqual([]);
		expect(
			plan.actions.open_cases.map((open) => ({
				tag: open.case_tag,
				type: open.case_type,
				repeat: open.repeat_context,
				indices: open.case_indices.map((index) => [
					index.tag,
					index.reference_id,
					index.relationship,
				]),
				open: open.open_condition,
				close: open.close_condition,
			})),
		).toEqual([
			{
				tag: "open_household_0",
				type: "household",
				repeat: "",
				indices: [],
				open: {
					type: "if",
					question: "/data/status",
					answer: "yes",
					operator: "=",
					doc_type: "FormActionCondition",
				},
				close: never,
			},
			{
				tag: "open_visit_1",
				type: "visit",
				repeat: "",
				indices: [["open_household_0", "parent", "child"]],
				open: always,
				close: {
					type: "if",
					question: "/data/status",
					answer: "no",
					operator: "=",
					doc_type: "FormActionCondition",
				},
			},
			{
				tag: "open_visit_2",
				type: "visit",
				repeat: "/data/kids",
				indices: [["open_visit_1", "parent", "extension"]],
				open: always,
				close: never,
			},
		]);
		// The row's case is the repeat's only indexed open action: its own
		// `case`, and owned by the worker through a generated node, since all
		// its indices are extensions.
		expect(plan.actions.open_cases[2]?.case_properties.owner_id).toEqual({
			question_path: "/data/kids/nova_owner_kid",
			update_mode: "always",
		});
		expect(plan.datums.map((datum) => [datum.id, datum.ref])).toEqual([
			["case_id_new_household_0", { kind: "new-case" }],
			["case_id_new_visit_1", { kind: "new-child-case", caseType: "visit" }],
		]);
		expect(
			plan.appendedNames.map(({ scope, name }) => `${scope.toXPath()}:${name}`),
		).toEqual([
			"/data:case_open_household_0",
			"/data:case_open_visit_1",
			"/data/kids:case",
		]);
		expect(plan.saveToCase).toEqual([]);
	});
});

// ── Over a corpus ────────────────────────────────────────────────────────

/** Every change `formUuid` holds is in exactly one of the plan's actions or
 *  Save to Case blocks: a basic slot, a load or an open action by its tag,
 *  or one block. A change that shares another's place counts with it. */
function placementCounts(
	doc: BlueprintDoc,
	formUuid: Uuid,
	plan: FormCaseWirePlan,
): Map<Uuid, number> {
	const { placements } = planPlacements(doc, formUuid);
	const tags =
		plan.kind === "advanced"
			? [
					...plan.actions.load_update_cases.map((load) => load.case_tag),
					...plan.actions.open_cases.map((open) => open.case_tag),
				]
			: [];
	const counts = new Map<Uuid, number>();
	for (const op of doc.forms[formUuid]?.caseOperations ?? []) {
		const planned = placements.get(op.uuid);
		const inBlocks = plan.saveToCase.filter(
			(block) =>
				block.subject.kind === "operation" &&
				block.subject.operationUuid === op.uuid,
		).length;
		const inActions =
			planned?.placement.kind === "basic"
				? 1
				: planned?.placement.kind === "advanced"
					? tags.filter(
							(tag) =>
								planned.placement.kind === "advanced" &&
								tag === planned.placement.tag,
						).length
					: planned?.sharesWith !== undefined
						? 1
						: 0;
		counts.set(op.uuid, inBlocks + inActions);
	}
	return counts;
}

function admittedCorpus(): BlueprintDoc[] {
	const sample = (arbitrary: fc.Arbitrary<BlueprintDoc>, seed: number) =>
		fc.sample(arbitrary, { seed, numRuns: 20 });
	return [
		...extensionScenarios.map(extensionCaseFixture),
		closeMembers().doc,
		registerHousehold().doc,
		...sample(suiteDocArbitrary, 20261102),
		...sample(blueprintDocArbitrary, 20261102),
	];
}

describe("planFormCaseWire over a corpus", () => {
	const corpus = admittedCorpus();

	it("places every case change in exactly one action or block", () => {
		let forms = 0;
		for (const doc of corpus)
			for (const formUuid of Object.keys(doc.forms) as Uuid[]) {
				const plan = planFormCaseWire(doc, formUuid);
				for (const [operationUuid, count] of placementCounts(
					doc,
					formUuid,
					plan,
				))
					expect({ formUuid, operationUuid, count }).toEqual({
						formUuid,
						operationUuid,
						count: 1,
					});
				for (const { name } of plan.appendedNames)
					expect(name).toMatch(
						/^(case|subcase_\d+|commcare_usercase|case_[a-zA-Z][\w-]*)$/,
					);
				forms++;
			}
		expect(forms).toBeGreaterThan(40);
	});

	it("gives every datum it plans to the form's entry, under the same id", () => {
		let datums = 0;
		for (const doc of corpus) {
			if (runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).length > 0) continue;
			const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
			for (const moduleUuid of doc.moduleOrder) {
				// A child menu's entry may rename a datum to align with its root
				// menu (`entries.py::EntriesHelper.add_parent_datums`).
				if (doc.modules[moduleUuid]?.parentModuleUuid !== undefined) continue;
				for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
					const entry = entryDatumIds(doc, ctx, moduleUuid, formUuid);
					for (const datum of planFormCaseWire(doc, formUuid).datums) {
						expect(
							entry
								.filter((row) => row.id === datum.id)
								.flatMap((row) => row.refs),
						).toContainEqual(datum.ref);
						datums++;
					}
				}
			}
		}
		expect(datums).toBeGreaterThan(5);
	});
});
