/**
 * The one plan that turns a form's placements into the wire: HQ's basic
 * actions, the Save to Case blocks, the new cases' datums and the blocks
 * HQ's build appends. Catches an action HQ builds differently from what the
 * placement chose, and a held path the plan does not write as held.
 */
import { describe, expect, it } from "vitest";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import { FormPath } from "@/lib/commcare/xform/formPath";
import type { CaseOperation } from "@/lib/domain";
import { eq } from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
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
		const plan = planFormCaseWire(doc, formUuid);
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
		const { actions, datums } = planFormCaseWire(doc, formUuid);
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
		const { actions, saveToCase } = planFormCaseWire(doc, formUuid);
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
		const { actions, saveToCase } = planFormCaseWire(doc, formUuid);
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
		const plan = planFormCaseWire(doc, formUuid);
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
		expect(planFormCaseWire(doc, formUuid).saveToCase).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("upd") },
				scope: FormPath.parse("/data/kids"),
				path: ["published_group", "published_block"],
				held: true,
			},
		]);
	});

	it("keeps a field-written extension child as HQ's inert subcase beside its active block", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: (t) => [
				own(),
				childCreate("ext", t, { links: [ownCaseLink(t, "extension")] }),
			],
		});
		const plan = planFormCaseWire(doc, formUuid);
		expect(plan.actions.subcases).toMatchObject([
			{ relationship: "extension", condition: { type: "never" } },
		]);
		expect(plan.saveToCase).toEqual([
			{
				subject: { kind: "operation", operationUuid: OP("ext") },
				scope: FormPath.root(),
				path: ["nova_subcases", "nova_subcase_0"],
				held: false,
			},
		]);
		expect(plan.datums.map((datum) => datum.id)).toEqual(["case_id_new_kid_0"]);
	});
});
