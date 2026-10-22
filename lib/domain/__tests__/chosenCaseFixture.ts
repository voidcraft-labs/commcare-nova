/**
 * Villages → Households → Members: each module picks its case after the
 * case of the module before it (`parentCaseModuleUuid`), so a Members entry
 * chooses a village, then a household, then a member. The shape part 05 §1.3
 * ("One id per slot") and part 06 §3.9 reason about: the village is
 * `parent_id` where Households' list runs as its own and `parent_parent_id`
 * where it runs as Members' parent choice.
 */
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "../blueprint";
import type { Expression } from "../expression/types";
import type { Uuid } from "../uuid";

export const chosen = {
	villages: testUuid("chosen-villages"),
	households: testUuid("chosen-households"),
	members: testUuid("chosen-members"),
	villageForm: testUuid("chosen-village-form"),
	householdForm: testUuid("chosen-household-form"),
	memberForm: testUuid("chosen-member-form"),
} as const;

export function chosenCaseDoc(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "village",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
			{
				name: "household",
				parent_type: "village",
				properties: [
					{ name: "village_name", label: "Village", data_type: "text" },
					{ name: "visit_day", label: "Visit day", data_type: "date" },
				],
			},
			{
				name: "member",
				parent_type: "household",
				properties: [
					{ name: "village_name", label: "Village", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
				],
			},
		],
		modules: [
			{
				uuid: chosen.villages,
				name: "Villages",
				caseType: "village",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: chosen.villageForm,
						name: "Visit village",
						type: "followup",
						fields: [f({ kind: "text", id: "village_note", label: "Note" })],
					},
				],
			},
			{
				uuid: chosen.households,
				name: "Households",
				caseType: "household",
				parentCaseModuleUuid: chosen.villages,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: chosen.householdForm,
						name: "Visit household",
						type: "followup",
						fields: [f({ kind: "text", id: "household_note", label: "Note" })],
					},
				],
			},
			{
				uuid: chosen.members,
				name: "Members",
				caseType: "member",
				parentCaseModuleUuid: chosen.households,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: chosen.memberForm,
						name: "Visit member",
						type: "followup",
						fields: [f({ kind: "text", id: "member_note", label: "Note" })],
					},
				],
			},
		],
	});
}

/** `chosen-case('<menu>')`: the id of the case chosen in `module`. */
export function chosenCase(module: Uuid): Expression {
	return {
		kind: "term",
		term: { kind: "session-datum", datum: { kind: "selected-case", module } },
	};
}

/** `chosen-case-property('<menu>', '<property>')`: a property of the case
 * chosen in `module`, whose case type is `caseType`. */
export function chosenCaseProperty(
	module: Uuid,
	caseType: string,
	property: string,
): Expression {
	return {
		kind: "project",
		of: {
			kind: "cases",
			source: "casedb",
			where: [
				{
					kind: "eq",
					left: {
						kind: "term",
						term: { kind: "prop", caseType, property: "case_id" },
					},
					right: chosenCase(module),
				},
			],
		},
		value: { kind: "prop", caseType, property },
	};
}
