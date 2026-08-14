import { describe, expect, it } from "vitest";
import { directCaseWritePlan } from "@/lib/agent/design/directCaseWrite";
import { fixtureValue, ids, makeContract } from "./fixtures";

function fixture() {
	const contract = makeContract();
	const workflow = fixtureValue(contract.workflows[0], "first workflow");
	const input = fixtureValue(workflow.inputs[0], "first workflow input");
	const record = fixtureValue(contract.records[0], "first record");
	const property = fixtureValue(record.properties[0], "first record property");
	return { input, property, workflow };
}

describe("directCaseWritePlan", () => {
	it("lowers an answer directly when the workflow writes that property", () => {
		expect(
			directCaseWritePlan({
				...fixture(),
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toEqual({ kind: "direct", property: "patient_name" });
	});

	it("does not lower an input bound to another property", () => {
		const value = fixture();
		value.input.propertyId = ids.factAge;
		expect(
			directCaseWritePlan({
				...value,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toBeNull();
	});

	it("requires an explicit workflow write", () => {
		const value = fixture();
		fixtureValue(
			value.workflow.recordEffects[0],
			"first record effect",
		).writes = [];
		expect(
			directCaseWritePlan({
				...value,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toBeNull();
	});

	it("keeps attachment and incompatible form scopes out of direct lowering", () => {
		const attachment = fixture();
		attachment.property.dataShape = "attachment";
		expect(
			directCaseWritePlan({
				...attachment,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toBeNull();

		const incompatible = fixture();
		expect(
			directCaseWritePlan({
				...incompatible,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: false,
				},
			}),
		).toBeNull();
	});

	it("lowers an identity property to its standard scalar, never a slug", () => {
		const named = fixture();
		named.property.identityRole = "case-name";
		expect(
			directCaseWritePlan({
				...named,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toEqual({ kind: "direct", property: "case_name" });

		const external = fixture();
		external.property.identityRole = "external-id";
		expect(
			directCaseWritePlan({
				...external,
				formContext: {
					caseType: "patient",
					directSlotTaken: false,
					repeatScopeCompatible: true,
				},
			}),
		).toEqual({ kind: "direct", property: "external_id" });
	});
});
