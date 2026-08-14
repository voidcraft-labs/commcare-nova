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

	it("routes the platform's standard names to their scalars by name alone", () => {
		// The display identity has no marker: a property NAMED case_name IS
		// the standard name slot, so the ordinary slug path lowers it to the
		// standard scalar write — same convention the built app uses.
		const named = fixture();
		named.property.name = "Case name";
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
		external.property.name = "External ID";
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
