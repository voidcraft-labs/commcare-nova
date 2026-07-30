import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	BlueprintCommitRejectedError,
	mutationTargetsInvalid,
} from "@/lib/db/commitGuard";
import type {
	BlueprintDoc,
	LookupColumnId,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import { caseOperationSchema } from "@/lib/domain";
import { eq, literal, tableColumn, tableLookup } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { makeStubToolContext } from "../../../__tests__/fixtures";
import { getFormTool } from "../../getForm";
import {
	addCaseOperationsInputSchema,
	addCaseOperationsTool,
} from "../addCaseOperations";
import { getCaseOperationsTool } from "../getCaseOperations";
import {
	moveCaseOperationInputSchema,
	moveCaseOperationTool,
} from "../moveCaseOperation";
import { removeCaseOperationTool } from "../removeCaseOperation";
import {
	type CaseOperationInput,
	caseOperationInputSchema,
	resolveCaseOperationInput,
} from "../shared";
import { updateCaseOperationTool } from "../updateCaseOperation";

const TEXT = testUuid("case-operation-field");
const CREATE_UUID = testUuid("create-visit-operation");
const UPDATE_UUID = testUuid("update-visit-operation");
const RETYPE_UUID = testUuid("retype-lead-operation");
const TAG_UUID = testUuid("tag-lead-operation");
const LOOKUP_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const LOOKUP_VALUE = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LOOKUP_FILTER = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;

const fieldValue = {
	kind: "term",
	term: { kind: "field", uuid: TEXT },
} as const;

const createVisit = {
	id: "create_visit",
	action: "create",
	caseType: "visit",
	target: { kind: "new" },
	name: fieldValue,
	writes: [{ property: "source_id", value: fieldValue }],
} as const satisfies CaseOperationInput;

const updateVisit = {
	id: "tag_visit",
	action: "update",
	caseType: "visit",
	target: { kind: "op", opUuid: CREATE_UUID },
	writes: [
		{
			property: "source_id",
			value: { kind: "id-of", opUuid: CREATE_UUID },
		},
	],
} as const satisfies CaseOperationInput;

const lookupExpression = tableLookup(
	LOOKUP_TABLE,
	LOOKUP_VALUE,
	eq(tableColumn(LOOKUP_TABLE, LOOKUP_FILTER), literal("enabled")),
);

function fixture(): {
	readonly doc: BlueprintDoc;
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
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
				caseListConfig: caseListConfig([
					{ field: "nickname", header: "Nickname" },
				]),
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
								label: proseText("Nickname"),
								caseWrite: { caseType: "patient", property: "nickname" },
							}),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
}

function item(operation: CaseOperationInput, operationUuid: Uuid) {
	return { operationUuid, operation };
}

function visitBatch() {
	return [item(createVisit, CREATE_UUID), item(updateVisit, UPDATE_UUID)];
}

describe("case-operation canonical author boundary", () => {
	it("accepts UUID expression leaves and rejects path/id aliases", () => {
		expect(caseOperationInputSchema.safeParse(createVisit).success).toBe(true);
		expect(caseOperationInputSchema.safeParse(updateVisit).success).toBe(true);

		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				name: {
					kind: "term",
					term: { kind: "field", path: "nickname" },
				},
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...updateVisit,
				target: { kind: "operation", operationId: "create_visit" },
			}).success,
		).toBe(false);
		expect(
			caseOperationInputSchema.safeParse({
				...updateVisit,
				writes: [
					{
						property: "source_id",
						value: { kind: "id-of", operationId: "create_visit" },
					},
				],
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

	it("constructs strict stored arms without own undefined facets", () => {
		const closeInput = {
			id: "close_visit",
			action: "close",
			caseType: "visit",
			target: { kind: "session" },
		} as const satisfies CaseOperationInput;
		const resolved = resolveCaseOperationInput(closeInput, CREATE_UUID);

		expect(caseOperationSchema.parse(resolved)).toEqual(resolved);
		expect(Object.hasOwn(resolved, "writes")).toBe(false);
		expect(Object.hasOwn(resolved, "links")).toBe(false);
		expect(Object.hasOwn(resolved, "name")).toBe(false);
		expect(Object.hasOwn(resolved, "owner")).toBe(false);
	});

	it("uses the validator's exact identifier vocabulary", () => {
		const accepted = {
			...createVisit,
			id: "_create_visit2",
			writes: [{ property: "source_id2", value: fieldValue }],
			links: [
				{
					identifier: "_parent2",
					targetType: "patient",
					target: null,
					relationship: "child",
				},
			],
		} as const;
		expect(caseOperationInputSchema.safeParse(accepted).success).toBe(true);

		for (const id of ["create-visit", "create.visit"]) {
			expect(
				caseOperationInputSchema.safeParse({ ...accepted, id }).success,
			).toBe(false);
		}
		for (const property of ["source-id", "source.id"]) {
			expect(
				caseOperationInputSchema.safeParse({
					...accepted,
					writes: [{ property, value: fieldValue }],
				}).success,
			).toBe(false);
		}
		for (const identifier of ["parent-link", "parent.link"]) {
			expect(
				caseOperationInputSchema.safeParse({
					...accepted,
					links: [{ ...accepted.links[0], identifier }],
				}).success,
			).toBe(false);
		}
	});

	it("publishes the same UUID and lookup vocabulary on the chat wire", async () => {
		const { moduleUuid, formUuid } = fixture();
		const wire = wireToolSchema(addCaseOperationsInputSchema);
		const json = JSON.stringify(await wire.jsonSchema);
		expect(json).toContain("operationUuid");
		expect(json).toContain("opUuid");
		expect(json).not.toContain("operationId");
		expect(
			caseOperationInputSchema.safeParse({
				...createVisit,
				owner: lookupExpression,
			}).success,
		).toBe(true);

		const valid = await wire.validate?.({
			moduleUuid,
			formUuid,
			operations: [
				item({ ...createVisit, owner: lookupExpression }, CREATE_UUID),
			],
		});
		expect(valid?.success).toBe(true);
		const rejected = await wire.validate?.({
			moduleUuid,
			formUuid,
			operations: [
				{
					operationUuid: CREATE_UUID,
					operation: {
						...createVisit,
						name: {
							kind: "term",
							term: { kind: "field", path: "nickname" },
						},
					},
				},
			],
		});
		expect(rejected?.success).toBe(false);
	});

	it("accepts UUID anchors and rejects numeric placement on add and move", () => {
		const { moduleUuid, formUuid } = fixture();
		expect(
			addCaseOperationsInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
				afterOperationUuid: null,
			}).success,
		).toBe(true);
		expect(
			addCaseOperationsInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
				index: 0,
			}).success,
		).toBe(false);
		expect(
			moveCaseOperationInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				afterOperationUuid: null,
			}).success,
		).toBe(true);
		expect(
			moveCaseOperationInputSchema.safeParse({
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				index: 0,
			}).success,
		).toBe(false);
	});
});

describe("shared case-operation tools", () => {
	it("adds a UUID-predeclared dependent batch atomically", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addCaseOperationsTool.execute(
			{ moduleUuid, formUuid, operations: visitBatch() },
			ctx,
			doc,
		);

		expect(result.result).toMatchObject({
			operationUuids: [CREATE_UUID, UPDATE_UUID],
			operationIds: ["create_visit", "tag_visit"],
			summary: { location: "Edit", count: 2 },
		});
		expect(recordMutations).toHaveBeenCalledTimes(1);
		const operations = result.newDoc.forms[formUuid].caseOperations ?? [];
		expect(operations).toHaveLength(2);
		expect(operations[0]).toMatchObject({
			uuid: CREATE_UUID,
			name: fieldValue,
		});
		expect(operations[1]).toMatchObject({
			uuid: UPDATE_UUID,
			target: { kind: "op", opUuid: CREATE_UUID },
			writes: [
				{
					property: "source_id",
					value: { kind: "id-of", opUuid: CREATE_UUID },
				},
			],
		});
	});

	it("returns canonical UUID references from both read tools", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{ moduleUuid, formUuid, operations: visitBatch() },
			ctx,
			doc,
		);
		const read = await getCaseOperationsTool.execute(
			{ moduleUuid, formUuid },
			ctx,
			added.newDoc,
		);
		const json = JSON.stringify(
			(read.data as { operations: readonly unknown[] }).operations,
		);
		expect(json).toContain(CREATE_UUID);
		expect(json).toContain(TEXT);
		expect(json).toContain('"opUuid"');
		expect(json).not.toContain('"path"');
		expect(json).not.toContain('"operationId"');

		const formRead = await getFormTool.execute(
			{ moduleUuid, formUuid },
			ctx,
			added.newDoc,
		);
		const formOperations =
			"form" in formRead.data ? formRead.data.form.caseOperations : undefined;
		expect(formOperations).toEqual(added.newDoc.forms[formUuid].caseOperations);
	});

	it("updates through granular patches with no whole-operation fallback", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
			},
			ctx,
			doc,
		);
		const result = await updateCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				operation: {
					...createVisit,
					id: "create_encounter",
					condition: { kind: "match-all" },
				},
			},
			ctx,
			added.newDoc,
		);

		expect(result.mutations).toEqual([
			expect.objectContaining({
				kind: "updateForm",
				caseOperationPatch: {
					operation: "update",
					uuid: CREATE_UUID,
					targetAction: "create",
					patch: {
						id: "create_encounter",
						condition: { kind: "match-all" },
					},
				},
			}),
		]);
		expect(
			result.mutations.some(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationChange !== undefined,
			),
		).toBe(false);
	});

	it("retargets across case types atomically", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{ moduleUuid, formUuid, operations: visitBatch() },
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const desired = {
			...updateVisit,
			caseType: "patient",
			target: { kind: "session" },
		} as const satisfies CaseOperationInput;
		const result = await updateCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationUuid: UPDATE_UUID,
				operation: desired,
			},
			ctx,
			added.newDoc,
		);

		expect(recordMutations).toHaveBeenCalledTimes(1);
		expect(
			result.mutations.filter(
				(mutation) =>
					mutation.kind === "updateForm" &&
					mutation.caseOperationPatch?.operation === "update",
			),
		).toEqual([
			expect.objectContaining({
				caseOperationPatch: {
					operation: "update",
					uuid: UPDATE_UUID,
					targetAction: "update",
					patch: {
						caseType: "patient",
						target: { kind: "session" },
					},
				},
			}),
		]);
	});

	it("refuses removing or moving a producer past its dependent", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{ moduleUuid, formUuid, operations: visitBatch() },
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const removed = await removeCaseOperationTool.execute(
			{ moduleUuid, formUuid, operationUuid: CREATE_UUID },
			ctx,
			added.newDoc,
		);
		expect(removed.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);

		const moved = await moveCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				afterOperationUuid: UPDATE_UUID,
			},
			ctx,
			added.newDoc,
		);
		expect(moved.result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("tag_visit") }),
		);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("reports canonical UUID placement for a no-op move", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();
		const moved = await moveCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationUuid: CREATE_UUID,
				afterOperationUuid: null,
			},
			ctx,
			added.newDoc,
		);
		expect(moved.result).toMatchObject({
			afterOperationUuid: null,
			operationOrder: [CREATE_UUID],
			message: 'Moved case operation "create_visit" to the beginning.',
		});
		expect(moved.mutations).toEqual([]);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("surfaces an authoritative race instead of reporting success", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const setup = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [item(createVisit, CREATE_UUID)],
			},
			setup.ctx,
			doc,
		);
		const stale = added.newDoc;
		const fresh = produce(stale, (draft) => {
			delete draft.forms[formUuid].caseOperations;
		});
		const { ctx, recordMutations } = makeStubToolContext();
		recordMutations.mockImplementation(async (prepared) => {
			if (mutationTargetsInvalid(fresh, prepared.mutations)) {
				throw new BlueprintCommitRejectedError(
					"A peer changed this case operation first.",
				);
			}
			return { events: [], committedDoc: prepared.nextDoc };
		});

		await expect(
			updateCaseOperationTool.execute(
				{
					moduleUuid,
					formUuid,
					operationUuid: CREATE_UUID,
					operation: { ...createVisit, id: "create_encounter" },
				},
				ctx,
				stale,
			),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(recordMutations).toHaveBeenCalledTimes(1);
	});
});

describe("dependency refusals name the actual constraint", () => {
	function retypeFixture(): {
		doc: BlueprintDoc;
		moduleUuid: Uuid;
		formUuid: Uuid;
	} {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "lead",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
				{
					name: "lead_copy",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					name: "Leads",
					caseType: "lead",
					caseListConfig: caseListConfig([{ field: "note", header: "Note" }]),
					forms: [
						{
							name: "Edit",
							type: "followup",
							fields: [
								f({
									uuid: testUuid("lead-note-field"),
									kind: "text",
									id: "note",
									label: proseText("Note"),
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
	}

	it("distinguishes target-type dependencies from identity references", async () => {
		const { doc, moduleUuid, formUuid } = retypeFixture();
		const noteUuid = doc.fieldOrder[formUuid][0];
		const retypeLead = {
			id: "retype_lead",
			action: "update",
			caseType: "lead",
			target: { kind: "session" },
			retype: "lead_copy",
		} as const satisfies CaseOperationInput;
		const tagLead = {
			id: "tag_lead",
			action: "update",
			caseType: "lead_copy",
			target: { kind: "session" },
			writes: [
				{
					property: "note",
					value: {
						kind: "term",
						term: { kind: "field", uuid: noteUuid },
					},
				},
			],
		} as const satisfies CaseOperationInput;
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [item(retypeLead, RETYPE_UUID), item(tagLead, TAG_UUID)],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const removed = await removeCaseOperationTool.execute(
			{ moduleUuid, formUuid, operationUuid: RETYPE_UUID },
			ctx,
			added.newDoc,
		);
		const removeError = (removed.result as { error: string }).error;
		expect(removeError).toContain("kind of case");
		expect(removeError).toContain("tag_lead");
		expect(removeError).not.toContain("uses its result");

		const moved = await moveCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationUuid: RETYPE_UUID,
				afterOperationUuid: TAG_UUID,
			},
			ctx,
			added.newDoc,
		);
		const moveError = (moved.result as { error: string }).error;
		expect(moveError).toContain("kind of case");
		expect(moveError).not.toContain("reference");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("still names a reference when that is what breaks", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{ moduleUuid, formUuid, operations: visitBatch() },
			ctx,
			doc,
		);
		const removed = await removeCaseOperationTool.execute(
			{ moduleUuid, formUuid, operationUuid: CREATE_UUID },
			ctx,
			added.newDoc,
		);
		const error = (removed.result as { error: string }).error;
		expect(error).toContain("uses its result");
		expect(error).not.toContain("kind of case");
	});
});
