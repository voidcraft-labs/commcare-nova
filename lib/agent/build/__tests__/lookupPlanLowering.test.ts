import { describe, expect, it } from "vitest";
import {
	deriveSliceExecutionBrief,
	renderBriefMessage,
} from "@/lib/agent/build/executionBrief";
import {
	did,
	ids,
	makeV2LookupContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { deriveBuildPlan } from "@/lib/agent/design/buildPlan";
import {
	type BuildPlanLookupMaterialization,
	type DesignLookupBinding,
	projectBuildPlanLookupBindings,
} from "@/lib/agent/design/lookupMaterializationTypes";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { lookupRevisionSchema } from "@/lib/lookup/schema";

const REVISION = {
	id: "00000000-0000-4000-8000-000000009801",
	digest: "e".repeat(64),
};
const TABLE_ID = lookupTableIdSchema.parse(
	"00000000-0000-7000-8000-000000009802",
);
const VALUE_COLUMN_ID = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-000000009803",
);
const LABEL_COLUMN_ID = lookupColumnIdSchema.parse(
	"00000000-0000-7000-8000-000000009804",
);

function materialization(): BuildPlanLookupMaterialization {
	return {
		receiptId: "00000000-0000-4000-8000-000000009805",
		resultDigest: "f".repeat(64),
		projectRevision: lookupRevisionSchema.parse("7"),
		bindings: [
			{
				kind: "lookup-table",
				designId: ids.lookupRisk,
				lookupId: TABLE_ID,
			},
			{
				kind: "lookup-column",
				designId: ids.lookupRiskValue,
				lookupId: VALUE_COLUMN_ID,
			},
			{
				kind: "lookup-column",
				designId: ids.lookupRiskLabel,
				lookupId: LABEL_COLUMN_ID,
			},
		],
	};
}

describe("accepted lookup plan lowering", () => {
	it("refuses to plan v2 lookup intent before its durable receipt exists", () => {
		expect(() =>
			deriveBuildPlan({ contract: makeV2LookupContract(), revision: REVISION }),
		).toThrow("requires its durable Project-data materialization receipt");
	});

	it("freezes the receipt in BuildPlan v2 and lowers Design IDs to lookup UUIDs", () => {
		const contract = makeV2LookupContract();
		const lookupMaterialization = materialization();
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			lookupMaterialization,
		});
		expect(plan.schemaVersion).toBe(2);
		if (plan.schemaVersion !== 2) throw new Error("Expected BuildPlan v2.");
		expect(plan.lookupMaterialization).toEqual(lookupMaterialization);

		const root = plan.slices.find(
			(slice) => slice.role === "materialization-root",
		);
		if (root === undefined) throw new Error("Expected a root build slice.");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: root.id,
		});
		expect(brief.schemaVersion).toBe(2);
		const risk = brief.records
			.flatMap((record) => record.properties)
			.find((property) => property.id === ids.factRisk);
		expect(risk?.choiceSource).toEqual({
			kind: "existing-project-lookup",
			tableId: TABLE_ID,
			valueColumnId: VALUE_COLUMN_ID,
			labelColumnId: LABEL_COLUMN_ID,
		});
		expect(brief.lookupMaterialization?.bindings).toEqual(
			lookupMaterialization.bindings,
		);
		expect(renderBriefMessage(brief)).toContain(TABLE_ID);
	});

	it("keeps many receipt row bindings out of the plan and execution brief", () => {
		const fullReceiptBindings: DesignLookupBinding[] = [
			...materialization().bindings,
			...Array.from({ length: 5_000 }, (_, index) => ({
				kind: "lookup-row" as const,
				designId: did(1_000 + index),
				lookupId:
					`018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}` as never,
			})),
		];
		const lookupMaterialization = {
			...materialization(),
			bindings: projectBuildPlanLookupBindings(fullReceiptBindings),
		};
		const contract = makeV2LookupContract();
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			lookupMaterialization,
		});
		if (plan.schemaVersion !== 2) throw new Error("Expected BuildPlan v2.");
		const root = plan.slices.find(
			(slice) => slice.role === "materialization-root",
		);
		if (root === undefined) throw new Error("Expected a root build slice.");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: root.id,
		});
		expect(plan.lookupMaterialization?.bindings).toHaveLength(3);
		expect(brief.lookupMaterialization?.bindings).toHaveLength(3);
		expect(JSON.stringify(plan.lookupMaterialization).length).toBeLessThan(800);
		expect(JSON.stringify(brief.lookupMaterialization).length).toBeLessThan(
			800,
		);
	});

	it("strips existing-lookup inspection evidence from the execution brief", () => {
		const contract = makeV2LookupContract();
		const risk = contract.records
			.flatMap((record) => record.properties)
			.find((property) => property.id === ids.factRisk);
		if (risk === undefined)
			throw new Error("Risk fixture property is missing.");
		contract.lookupTables = [];
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: TABLE_ID,
			valueColumnId: VALUE_COLUMN_ID,
			labelColumnId: LABEL_COLUMN_ID,
			inspection: {
				tableRevision: lookupRevisionSchema.parse("7"),
				tableName: "Risk levels",
				valueColumnLabel: "Value",
				labelColumnLabel: "Label",
				rowCount: 2,
				projectionDigest: "a".repeat(64),
				distinctValueCount: 2,
				invalidValueCount: 0,
				blankLabelCount: 0,
				duplicateValueCount: 0,
			},
		};
		const lookupMaterialization = { ...materialization(), bindings: [] };
		const plan = deriveBuildPlan({
			contract,
			revision: REVISION,
			lookupMaterialization,
		});
		const root = plan.slices.find(
			(slice) => slice.role === "materialization-root",
		);
		if (root === undefined) throw new Error("Expected a root build slice.");
		const brief = deriveSliceExecutionBrief({
			contract,
			revision: REVISION,
			plan,
			sliceId: root.id,
		});
		const loweredRisk = brief.records
			.flatMap((record) => record.properties)
			.find((property) => property.id === ids.factRisk);

		expect(loweredRisk?.choiceSource).toEqual({
			kind: "existing-project-lookup",
			tableId: TABLE_ID,
			valueColumnId: VALUE_COLUMN_ID,
			labelColumnId: LABEL_COLUMN_ID,
		});
		expect(JSON.stringify(brief)).not.toContain("projectionDigest");
	});

	it("fails closed when an accepted designed identity is absent from the receipt", () => {
		const contract = makeV2LookupContract();
		const incomplete = materialization();
		incomplete.bindings = incomplete.bindings.filter(
			(binding) => binding.designId !== ids.lookupRiskLabel,
		);
		expect(() =>
			deriveBuildPlan({
				contract,
				revision: REVISION,
				lookupMaterialization: incomplete,
			}),
		).toThrow(
			`missing the lookup-column binding for accepted Design ID ${ids.lookupRiskLabel}`,
		);
	});
});
