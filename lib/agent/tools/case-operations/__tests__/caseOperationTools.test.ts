import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { asUuid, type BlueprintDoc } from "@/lib/domain";
import { makeStubToolContext } from "../../../__tests__/fixtures";
import { getFormTool } from "../../getForm";
import {
	addCaseOperationsInputSchema,
	addCaseOperationsTool,
} from "../addCaseOperations";
import { getCaseOperationsTool } from "../getCaseOperations";
import { moveCaseOperationTool } from "../moveCaseOperation";
import { removeCaseOperationTool } from "../removeCaseOperation";
import {
	authorValueExpressionSchema,
	caseOperationInputSchema,
} from "../shared";
import { updateCaseOperationTool } from "../updateCaseOperation";

const TEXT = asUuid("44444444-4444-4444-8444-444444444444");

function fixture(): {
	readonly doc: BlueprintDoc;
	readonly formUuid: ReturnType<typeof asUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: "Nickname", data_type: "text" },
				],
			},
			{
				name: "visit",
				properties: [
					{ name: "source_id", label: "Source ID", data_type: "text" },
				],
			},
		],
		modules: [
			{
				id: "patients",
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						id: "edit",
						name: "Edit",
						type: "followup",
						fields: [
							f({
								uuid: TEXT,
								kind: "text",
								id: "nickname",
								label: "Nickname",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, formUuid: doc.formOrder[moduleUuid][0] };
}

const fieldValue = {
	kind: "term" as const,
	term: { kind: "field" as const, path: "nickname" },
};

const createVisit = {
	id: "create_visit",
	action: "create" as const,
	caseType: "visit",
	target: { kind: "new" as const },
	name: fieldValue,
	writes: [{ property: "source_id", value: fieldValue }],
};

const updateVisit = {
	id: "tag_visit",
	action: "update" as const,
	caseType: "visit",
	target: {
		kind: "operation" as const,
		operationId: "create_visit",
	},
	writes: [
		{
			property: "source_id",
			value: { kind: "id-of" as const, operationId: "create_visit" },
		},
	],
};

describe("case-operation author boundary", () => {
	it("accepts field paths and operation ids, but never UUID leaves", () => {
		expect(authorValueExpressionSchema.safeParse(fieldValue).success).toBe(
			true,
		);
		expect(
			authorValueExpressionSchema.safeParse({
				kind: "term",
				term: { kind: "field", uuid: TEXT },
			}).success,
		).toBe(false);
		expect(
			authorValueExpressionSchema.safeParse({
				kind: "id-of",
				opUuid: asUuid("11111111-1111-4111-8111-111111111111"),
			}).success,
		).toBe(false);
	});

	it("makes illegal action facets and platform-owned types unconstructible", () => {
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				target: { kind: "session" },
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				caseType: "commcare-user",
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				id: "close_visit",
				action: "close",
				caseType: "visit",
				target: { kind: "session" },
				owner: fieldValue,
			}).success,
		).toBe(false);
	});

	it("keeps the chat wire compact without weakening author validation", async () => {
		const wire = wireToolSchema(addCaseOperationsInputSchema);
		const json = JSON.stringify(await wire.jsonSchema);
		expect(json).toContain("Author ValueExpression AST node");
		expect(json).not.toContain("table-column");
		expect(json).not.toContain("table-lookup");

		const valid = await wire.validate?.({
			moduleId: "patients",
			formId: "edit",
			operations: [createVisit],
		});
		expect(valid?.success).toBe(true);
		const rejected = await wire.validate?.({
			moduleId: "patients",
			formId: "edit",
			operations: [
				{
					...createVisit,
					name: {
						kind: "term",
						term: { kind: "field", uuid: TEXT },
					},
				},
			],
		});
		expect(rejected?.success).toBe(false);
	});
});

describe("shared case-operation tools", () => {
	it("adds a dependent batch atomically and resolves every author identity", async () => {
		const { doc, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);

		expect(result.result).toMatchObject({
			operationIds: ["create_visit", "tag_visit"],
			summary: { location: "Edit", count: 2 },
		});
		expect(recordMutations).toHaveBeenCalledTimes(1);
		const operations = result.newDoc.forms[formUuid].caseOperations ?? [];
		expect(operations).toHaveLength(2);
		expect(operations[0].name).toEqual({
			kind: "term",
			term: { kind: "field", uuid: TEXT },
		});
		expect(operations[1].target).toEqual({
			kind: "op",
			opUuid: operations[0].uuid,
		});
		expect(operations[1].writes?.[0].value).toEqual({
			kind: "id-of",
			opUuid: operations[0].uuid,
		});
	});

	it("returns an author projection with no UUID vocabulary", async () => {
		const { doc } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		const read = await getCaseOperationsTool.execute(
			{ moduleId: "patients", formId: "edit" },
			ctx,
			added.newDoc,
		);
		const json = JSON.stringify(read.data);
		expect(json).not.toContain("uuid");
		expect(json).not.toContain("Uuid");
		expect(json).toContain('"path":"nickname"');
		expect(json).toContain('"operationId":"create_visit"');

		const formRead = await getFormTool.execute(
			{ moduleIndex: 0, formIndex: 0 },
			ctx,
			added.newDoc,
		);
		const formOperations =
			"form" in formRead.data ? formRead.data.form.caseOperations : undefined;
		const formJson = JSON.stringify(formOperations);
		expect(formJson).not.toContain("uuid");
		expect(formJson).not.toContain("Uuid");
		expect(formJson).toContain('"operationId":"create_visit"');
	});

	it("updates through granular identity-keyed mutations", async () => {
		const { doc } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [createVisit],
			},
			ctx,
			doc,
		);
		const result = await updateCaseOperationTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operationId: "create_visit",
				operation: {
					...createVisit,
					id: "create_encounter",
					condition: { kind: "match-all" },
				},
			},
			ctx,
			added.newDoc,
		);

		expect(result.mutations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "updateForm",
					caseOperationChange: expect.objectContaining({
						operation: "update",
						patch: expect.objectContaining({
							id: "create_encounter",
							condition: { kind: "match-all" },
						}),
					}),
				}),
			]),
		);
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange?.operation === "update" &&
					"value" in mutation.caseOperationChange,
			),
		).toBe(false);
	});

	it("refuses removing or moving a producer past its dependent", async () => {
		const { doc } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const removed = await removeCaseOperationTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operationId: "create_visit",
			},
			ctx,
			added.newDoc,
		);
		expect(removed.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);

		const moved = await moveCaseOperationTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operationId: "create_visit",
				index: 1,
			},
			ctx,
			added.newDoc,
		);
		expect(moved.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);
		expect(recordMutations).not.toHaveBeenCalled();
	});
});
