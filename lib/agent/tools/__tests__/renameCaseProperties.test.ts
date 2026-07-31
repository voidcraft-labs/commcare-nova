import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { makeStubToolContext } from "@/lib/agent/__tests__/fixtures";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { type BlueprintDoc, fieldCaseWrite } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	renameCasePropertiesInputSchema,
	renameCasePropertiesTool,
} from "../renameCaseProperties";

const MODULE = testUuid("10000000-0000-4000-8000-000000000000");
const FORM = testUuid("20000000-0000-4000-8000-000000000000");
const FIELD = testUuid("30000000-0000-4000-8000-000000000000");
const OPERATION = testUuid("40000000-0000-4000-8000-000000000000");
const COLUMN = testUuid("50000000-0000-4000-8000-000000000000");

function fixture(): BlueprintDoc {
	return {
		appId: "app",
		appName: "App",
		connectType: null,
		caseTypes: [
			{
				name: "patient",
				properties: ["phone", "email"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text" as const,
				})),
			},
		],
		modules: {
			[MODULE]: {
				uuid: MODULE,
				id: "patients",
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{
							uuid: COLUMN,
							kind: "plain",
							field: "phone",
							header: "Phone",
						},
					],
					listColumnOrder: [COLUMN],
					detailColumnOrder: [COLUMN],
					searchInputs: [],
				},
			},
		},
		forms: {
			[FORM]: {
				uuid: FORM,
				id: "edit_patient",
				name: "Edit patient",
				type: "followup",
				caseOperations: [
					{
						uuid: OPERATION,
						id: "write_phone",
						action: "update",
						caseType: "patient",
						target: { kind: "session" },
						writes: [
							{
								property: "phone",
								value: term(literal("555-0100")),
							},
						],
					},
				],
			},
		},
		fields: {
			[FIELD]: {
				uuid: FIELD,
				id: "contact_number",
				kind: "text",
				label: proseText("Phone"),
				caseWrite: { caseType: "patient", property: "phone" },
			},
		},
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [FIELD] },
		fieldParent: { [FIELD]: FORM },
	};
}

describe("renameCaseProperties shared SA/MCP tool", () => {
	it("commits one exclusive semantic command and reports exact grouped document impact", async () => {
		const doc = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const input = {
			renames: [
				{
					caseType: "patient",
					from: "phone",
					to: "primary_phone",
				},
			],
		};

		const outcome = await renameCasePropertiesTool.execute(input, ctx, doc);

		expect(outcome.result).not.toHaveProperty("error");
		expect(outcome.mutations).toEqual([
			{ kind: "renameCaseProperties", renames: input.renames },
		]);
		expect(recordMutations).toHaveBeenCalledTimes(1);
		expect(recordMutations.mock.calls[0]?.[1]).toBe("case-properties:rename");
		expect(outcome.newDoc.fields[FIELD].id).toBe("contact_number");
		expect(fieldCaseWrite(outcome.newDoc.fields[FIELD])).toEqual({
			caseType: "patient",
			property: "primary_phone",
		});
		expect(
			outcome.newDoc.forms[FORM].caseOperations?.[0]?.writes?.[0]?.property,
		).toBe("primary_phone");
		expect(
			outcome.newDoc.caseTypes?.[0]?.properties.map(({ name }) => name),
		).toEqual(["primary_phone", "email"]);
		expect(
			outcome.newDoc.modules[MODULE].caseListConfig?.columns[0],
		).toMatchObject({ field: "primary_phone" });

		expect(outcome.result).toMatchObject({
			renames: input.renames,
			impact: {
				totalOccurrences: 4,
				totalCarriers: 4,
				groups: [
					{ key: "field-writers", occurrences: 1, carriers: 1 },
					{
						key: "case-operation-writes",
						occurrences: 1,
						carriers: 1,
					},
					{ key: "typed-reads", occurrences: 1, carriers: 1 },
					{
						key: "catalog-declarations",
						occurrences: 1,
						carriers: 1,
					},
				],
				byRename: [{ ...input.renames[0], occurrences: 4 }],
			},
			summary: { count: 1 },
		});
	});

	it("refuses an occupied destination without persisting a partial edit", async () => {
		const doc = fixture();
		const { ctx, recordMutations } = makeStubToolContext();

		const outcome = await renameCasePropertiesTool.execute(
			{
				renames: [{ caseType: "patient", from: "phone", to: "email" }],
			},
			ctx,
			doc,
		);

		expect(outcome.mutations).toEqual([]);
		expect(outcome.newDoc).toBe(doc);
		expect(recordMutations).not.toHaveBeenCalled();
		expect(outcome.result).toEqual({
			error: expect.stringContaining("Nothing was changed"),
		});
	});

	it("requires a complete nonempty canonical relation at the callable boundary", () => {
		expect(
			renameCasePropertiesInputSchema.safeParse({ renames: [] }).success,
		).toBe(false);
		expect(
			renameCasePropertiesInputSchema.safeParse({
				renames: [{ caseType: "patient", from: "phone" }],
			}).success,
		).toBe(false);
		expect(
			renameCasePropertiesInputSchema.safeParse({
				renames: [{ caseType: "patient", from: "phone", to: "external-id" }],
			}).success,
		).toBe(false);
		expect(
			renameCasePropertiesInputSchema.safeParse({
				renames: [
					{
						caseType: "patient",
						from: "phone",
						to: "primary_phone",
						field: "contact_number",
					},
				],
			}).success,
		).toBe(false);
	});

	it("registers one edit-capable tool with the exact SA and MCP names and schema", () => {
		const entry = SHARED_TOOL_REGISTRY.find(
			(candidate) => candidate.saName === "renameCaseProperties",
		);
		expect(entry).toEqual({
			saName: "renameCaseProperties",
			mcpName: "rename_case_properties",
			tool: renameCasePropertiesTool,
			requires: "edit",
		});

		const wire = wireToolSchema(renameCasePropertiesInputSchema);
		expect(wire.jsonSchema).toMatchObject({
			type: "object",
			required: ["renames"],
			additionalProperties: false,
		});
	});
});
