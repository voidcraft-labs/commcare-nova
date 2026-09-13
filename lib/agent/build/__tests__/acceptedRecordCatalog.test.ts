import { describe, expect, it } from "vitest";
import {
	makeCanonicalGenesisDoc,
	makeToolWorkspaceHarness,
} from "@/lib/agent/__tests__/fixtures";
import {
	cloneContract,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import type { RecordConcept } from "@/lib/agent/design/contract";
import { designConstructionIssues } from "@/lib/agent/design/contract";
import { generateSchemaTool } from "@/lib/agent/tools/generateSchema";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import {
	acceptedRecordCatalogInput,
	deriveAcceptedPropertyNames,
	prepareAcceptedRecordCatalog,
} from "../acceptedRecordCatalog";
import { deriveSliceExecutionBrief } from "../executionBrief";

function record(names: readonly string[]): RecordConcept {
	return {
		id: did(900),
		name: "Plots",
		purpose: "A plot",
		lifecycleStates: [],
		properties: names.map((name, index) => ({
			id: did(1000 + index),
			name,
			meaning: name,
			dataShape: "text",
			sensitivity: "ordinary",
		})),
	};
}

describe("accepted record preparation", () => {
	it("keeps a business status and literal accepted wording through canonical storage", async () => {
		const contract = cloneContract(makeContract());
		const property = fixtureValue(
			contract.records[0].properties.find((item) => item.id === ids.factRisk),
			"risk",
		);
		property.name = "status";
		property.choices = [
			{ value: "routine", label: "Type {{A}}" },
			{ value: "priority", label: "Follow-up \\ eGFR" },
		];
		const revision = { id: ids.revisionId, digest: "b".repeat(64) };
		const plan = deriveBuildPlan({ contract, revision });
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: plan.slices[0].id,
		});
		const h = makeToolWorkspaceHarness(makeCanonicalGenesisDoc());
		await h.workspace.invoke({
			toolName: "generateSchema",
			async execute(ctx) {
				const prepared = await prepareAcceptedRecordCatalog(
					ctx,
					acceptedRecordCatalogInput(brief),
				);
				return generateSchemaTool.execute(
					generateSchemaTool.inputSchema.parse(prepared.input),
					ctx,
				);
			},
		});
		const saved = h.workspace
			.currentSnapshot()
			.doc.caseTypes?.find((item) => item.name === "patient")
			?.properties.find((item) => item.name === "property_status");
		expect(saved).toMatchObject({
			data_type: "single_select",
			label: { parts: [{ kind: "text", text: "status" }] },
			options: [
				{
					value: "routine",
					label: { parts: [{ kind: "text", text: "Type {{A}}" }] },
				},
				{
					value: "priority",
					label: { parts: [{ kind: "text", text: "Follow-up \\ eGFR" }] },
				},
			],
		});
	});
	it("refuses ambiguous or non-text display-name semantics before construction", () => {
		const contract = cloneContract(makeContract());
		contract.records[0].properties[0].name = "case_name";
		contract.records[0].properties[1].name = "case_name";
		const issues = designConstructionIssues(contract);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: ["records", 0, "properties", 1, "dataShape"],
				}),
				expect.objectContaining({
					path: ["records", 0, "properties", 1, "name"],
				}),
			]),
		);
	});
	it("keeps property names distinct across slug, suffix, truncation and order collisions", () => {
		const source = record([
			"Plot area",
			"Plot-area",
			`plot_area_${did(1000).replaceAll("-", "")}`,
			"x".repeat(300),
			"x".repeat(301),
		]);
		const names = deriveAcceptedPropertyNames(source);
		expect(new Set(names.values()).size).toBe(source.properties.length);
		for (const name of names.values())
			expect(authoredCasePropertyNameSchema.safeParse(name).success).toBe(true);
		expect(
			deriveAcceptedPropertyNames({
				...source,
				properties: [...source.properties].reverse(),
			}),
		).toEqual(names);
	});
	it("reserves scalar meanings for their explicit accepted names", () => {
		const source = record([
			"case_name",
			"Case name",
			"external_id",
			"External ID",
			"name",
			"123",
			"owner_id",
		]);
		expect([...deriveAcceptedPropertyNames(source).values()]).toEqual([
			"case_name",
			"property_case_name",
			"external_id",
			"property_external_id",
			"property_name",
			"property_123",
			"property_owner_id",
		]);
	});
	it("prepares intrinsic types and exact choices while leaving contextual requirements to forms", () => {
		const contract = cloneContract(makeContract());
		const patient = fixtureValue(contract.records[0], "patient");
		const risk = fixtureValue(
			patient.properties.find((item) => item.id === ids.factRisk),
			"risk",
		);
		risk.choices = [
			{ value: "R", label: "Routine follow-up" },
			{ value: "U", label: "Contact a supervisor today" },
		];
		const revision = { id: ids.revisionId, digest: "b".repeat(64) };
		const plan = deriveBuildPlan({ contract, revision });
		const brief = deriveSliceExecutionBrief({
			contract,
			revision,
			plan,
			sliceId: plan.slices[0].id,
		});
		const catalog = acceptedRecordCatalogInput(brief);
		expect(catalog.caseTypes[0].properties).toEqual([
			{ name: "patient_name", label: "Patient name", data_type: "text" },
			{ name: "age", label: "Age", data_type: "int" },
			{
				name: "risk_level",
				label: "Risk level",
				data_type: "single_select",
				options: risk.choices,
			},
		]);
		// The accepted registration requiredness is prose about a workflow,
		// not a catalog expression to copy or guess at.
		expect(patient.properties[0].requiredWhen).toBeDefined();
		expect(brief.toolProfile.mutationTools).not.toContain("generateSchema");
	});
});
