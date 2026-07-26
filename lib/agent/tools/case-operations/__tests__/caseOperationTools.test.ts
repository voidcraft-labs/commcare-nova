import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	BlueprintCommitRejectedError,
	batchTargetsMissing,
} from "@/lib/db/commitGuard";
import { keyBetween } from "@/lib/doc/order/keys";
import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	type CaseOperation,
	type LookupColumnId,
	type LookupTableId,
	orderedCaseOperations,
} from "@/lib/domain";
import {
	eq,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
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
const LOOKUP_TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const LOOKUP_VALUE = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;
const LOOKUP_FILTER = "018f3e8a-7b2c-7def-8abc-1234567890ae" as LookupColumnId;
const lookupExpression = tableLookup(
	LOOKUP_TABLE,
	LOOKUP_VALUE,
	eq(tableColumn(LOOKUP_TABLE, LOOKUP_FILTER), literal("enabled")),
);
const lookupPredicate = eq(
	tableColumn(LOOKUP_TABLE, LOOKUP_FILTER),
	literal("enabled"),
);

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

	it("uses the validator's exact identifier vocabulary on every author slot", () => {
		const accepted = {
			...createVisit,
			id: "_create_visit2",
			writes: [{ property: "source_id2", value: fieldValue }],
			links: [
				{
					identifier: "_parent2",
					targetType: "patient",
					target: null,
					relationship: "child" as const,
				},
			],
		};
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
					caseOperationPatch: expect.objectContaining({
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
		).toBe(true);
	});

	it("refuses every carrier-blind read-to-update shape before hidden behavior can be cleared", async () => {
		const cases: readonly {
			readonly slot: string;
			readonly operation: CaseOperation;
			readonly authorShape: Parameters<
				typeof updateCaseOperationTool.execute
			>[0]["operation"];
		}[] = [
			{
				slot: "condition",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000001"),
					id: "carrier_condition",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Visit")),
					condition: lookupPredicate,
				},
				authorShape: {
					...createVisit,
					id: "renamed_condition",
					condition: undefined,
				},
			},
			{
				slot: "name",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000002"),
					id: "carrier_name",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: lookupExpression,
				},
				authorShape: {
					...createVisit,
					id: "renamed_name",
					name: fieldValue,
				},
			},
			{
				slot: "owner",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000003"),
					id: "carrier_owner",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Visit")),
					owner: lookupExpression,
				},
				authorShape: {
					...createVisit,
					id: "renamed_owner",
					owner: undefined,
				},
			},
			{
				slot: "rename",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000004"),
					id: "carrier_rename",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					rename: lookupExpression,
				},
				authorShape: {
					id: "renamed_rename",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
				},
			},
			{
				slot: "write value",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000005"),
					id: "carrier_write_value",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Visit")),
					writes: [{ property: "source_id", value: lookupExpression }],
				},
				authorShape: {
					...createVisit,
					id: "renamed_write_value",
					writes: undefined,
				},
			},
			{
				slot: "write condition",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000006"),
					id: "carrier_write_condition",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Visit")),
					writes: [
						{
							property: "source_id",
							value: term(literal("visible")),
							condition: lookupPredicate,
						},
					],
				},
				authorShape: {
					...createVisit,
					id: "renamed_write_condition",
					writes: [
						{
							property: "source_id",
							value: {
								kind: "term",
								term: { kind: "literal", value: "visible" },
							},
						},
					],
				},
			},
			{
				slot: "link target",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000007"),
					id: "carrier_link",
					action: "create",
					caseType: "visit",
					target: { kind: "new" },
					name: term(literal("Visit")),
					links: [
						{
							identifier: "parent",
							targetType: "patient",
							target: { kind: "expression", expr: lookupExpression },
							relationship: "child",
						},
					],
				},
				authorShape: {
					...createVisit,
					id: "renamed_link",
					links: undefined,
				},
			},
			{
				slot: "operation target",
				operation: {
					uuid: asUuid("10000000-0000-4000-8000-000000000008"),
					id: "carrier_target",
					action: "update",
					caseType: "patient",
					target: { kind: "expression", expr: lookupExpression },
				},
				authorShape: {
					id: "renamed_target",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
				},
			},
		];

		for (const scenario of cases) {
			const { doc, formUuid } = fixture();
			const operation = { ...scenario.operation, order: "a" };
			const safePeer: CaseOperation = {
				uuid: asUuid("10000000-0000-4000-8000-000000000099"),
				id: "safe_peer",
				order: "c",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			};
			doc.forms[formUuid].caseOperations = [operation, safePeer];
			const { ctx, recordMutations } = makeStubToolContext();
			const read = await getCaseOperationsTool.execute(
				{ moduleId: "patients", formId: "edit" },
				ctx,
				doc,
			);
			expect(JSON.stringify(read.data), scenario.slot).not.toMatch(
				/table-column|table-lookup/,
			);
			if ("error" in read.data) throw new Error(read.data.error);
			expect(
				read.data.operations.map((candidate) => candidate.id),
				scenario.slot,
			).toEqual([operation.id, "safe_peer"]);
			expect(read.data.operations[0], scenario.slot).toEqual({
				id: operation.id,
				action: operation.action,
				caseType: operation.caseType,
				unavailable: {
					kind: "lookup-table-logic",
					reason:
						"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.",
				},
			});

			const result = await updateCaseOperationTool.execute(
				{
					moduleId: "patients",
					formId: "edit",
					operationId: operation.id,
					operation: scenario.authorShape,
				},
				ctx,
				doc,
			);

			expect(result.result, scenario.slot).toEqual(
				expect.objectContaining({
					error: expect.stringContaining(
						"uses lookup-table logic that Nova preserves but cannot safely edit from this surface",
					),
				}),
			);
			expect(result.mutations, scenario.slot).toEqual([]);
			expect(result.newDoc, scenario.slot).toBe(doc);
			expect(
				result.newDoc.forms[formUuid].caseOperations?.[0],
				scenario.slot,
			).toEqual(operation);
			expect(recordMutations, scenario.slot).not.toHaveBeenCalled();

			const moved = await moveCaseOperationTool.execute(
				{
					moduleId: "patients",
					formId: "edit",
					operationId: operation.id,
					index: 1,
				},
				ctx,
				doc,
			);
			expect(moved.result, scenario.slot).toMatchObject({ index: 1 });
			expect(recordMutations, scenario.slot).toHaveBeenCalledTimes(1);
			const movedOperation = moved.newDoc.forms[formUuid].caseOperations?.find(
				(candidate) => candidate.uuid === operation.uuid,
			);
			expect(movedOperation, scenario.slot).toEqual({
				...operation,
				order: movedOperation?.order,
			});
			expect(JSON.stringify(moved.mutations), scenario.slot).not.toMatch(
				/table-column|table-lookup/,
			);
		}
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

	it("reports the actual clamped move destination", async () => {
		const { doc } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [createVisit],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();
		const moved = await moveCaseOperationTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operationId: "create_visit",
				index: 999,
			},
			ctx,
			added.newDoc,
		);
		expect(moved.result).toMatchObject({
			index: 0,
			message: 'Moved case operation "create_visit" to index 0.',
		});
		expect(moved.mutations).toEqual([]);
		expect(moved.newDoc).toBe(added.newDoc);
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("rejects an authoritative peer shift instead of reporting the stale requested rank", async () => {
		const { doc, formUuid } = fixture();
		const setup = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [
					{ ...createVisit, id: "first_visit" },
					{ ...createVisit, id: "second_visit" },
					{ ...createVisit, id: "third_visit" },
				],
			},
			setup.ctx,
			doc,
		);
		const stale = added.newDoc;
		const ordered = orderedCaseOperations(stale.forms[formUuid]);
		const first = ordered[0];
		if (first?.order === undefined) throw new Error("fixture order missing");
		const firstOrder = first.order;

		const { ctx, recordMutations } = makeStubToolContext();
		recordMutations.mockImplementation(
			async (mutations: Mutation[], candidate: BlueprintDoc) => {
				const move = mutations.find(
					(mutation): mutation is Extract<Mutation, { kind: "updateForm" }> =>
						mutation.kind === "updateForm" &&
						mutation.caseOperationPatch?.operation === "move",
				);
				if (move === undefined) throw new Error("move intent missing");
				const movePatch = move.caseOperationPatch;
				if (movePatch?.operation !== "move" || movePatch.order === null) {
					throw new Error("move intent missing");
				}
				const moveOrder = movePatch.order;
				expect(movePatch.index).toBe(1);
				expect(move.caseOperationChange).toEqual({
					operation: "move",
					uuid: movePatch.uuid,
					order: moveOrder,
				});

				const fresh = produce(stale, (draft) => {
					draft.forms[formUuid].caseOperations?.push({
						...first,
						uuid: asUuid("10000000-0000-4000-8000-000000000099"),
						id: "peer_visit",
						order: keyBetween(firstOrder, moveOrder),
					});
				});
				if (batchTargetsMissing(fresh, mutations)) {
					throw new BlueprintCommitRejectedError(
						"A peer changed this case operation first.",
					);
				}
				return { events: [], committedDoc: candidate };
			},
		);

		await expect(
			moveCaseOperationTool.execute(
				{
					moduleId: "patients",
					formId: "edit",
					operationId: "third_visit",
					index: 1,
				},
				ctx,
				stale,
			),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(recordMutations).toHaveBeenCalledTimes(1);
	});

	it("surfaces authoritative operation/write/link races instead of reporting success", async () => {
		const { doc, formUuid } = fixture();
		const linkedVisit = {
			...createVisit,
			links: [
				{
					identifier: "parent",
					targetType: "patient",
					target: null,
					relationship: "child" as const,
				},
			],
		};
		const setup = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleId: "patients",
				formId: "edit",
				operations: [linkedVisit],
			},
			setup.ctx,
			doc,
		);
		const stale = added.newDoc;

		const expectConflict = async (
			fresh: BlueprintDoc,
			operation: Parameters<
				typeof updateCaseOperationTool.execute
			>[0]["operation"],
		) => {
			const { ctx, recordMutations } = makeStubToolContext();
			recordMutations.mockImplementation(
				async (mutations: Mutation[], candidate: BlueprintDoc) => {
					if (batchTargetsMissing(fresh, mutations)) {
						throw new BlueprintCommitRejectedError(
							"A peer changed this case operation first.",
						);
					}
					return { events: [], committedDoc: candidate };
				},
			);
			await expect(
				updateCaseOperationTool.execute(
					{
						moduleId: "patients",
						formId: "edit",
						operationId: "create_visit",
						operation,
					},
					ctx,
					stale,
				),
			).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
			expect(recordMutations).toHaveBeenCalledTimes(1);
		};

		await expectConflict(
			produce(stale, (draft) => {
				delete draft.forms[formUuid].caseOperations;
			}),
			{ ...linkedVisit, id: "create_encounter" },
		);

		await expectConflict(
			produce(stale, (draft) => {
				delete draft.forms[formUuid].caseOperations?.[0]?.writes;
			}),
			{
				...linkedVisit,
				writes: [
					{
						property: "source_id",
						value: {
							kind: "term",
							term: { kind: "literal", value: "changed" },
						},
					},
				],
			},
		);

		await expectConflict(
			produce(stale, (draft) => {
				delete draft.forms[formUuid].caseOperations?.[0]?.links;
			}),
			{
				...linkedVisit,
				links: [{ ...linkedVisit.links[0], relationship: "extension" }],
			},
		);

		const peerWrite = {
			property: "note",
			value: {
				kind: "term" as const,
				term: { kind: "literal" as const, value: "peer" },
			},
		};
		await expectConflict(
			produce(stale, (draft) => {
				draft.forms[formUuid].caseOperations?.[0]?.writes?.push(peerWrite);
			}),
			{
				...linkedVisit,
				writes: [...linkedVisit.writes, peerWrite],
			},
		);

		const peerLink = {
			identifier: "household",
			targetType: "patient",
			target: null,
			relationship: "child" as const,
		};
		await expectConflict(
			produce(stale, (draft) => {
				draft.forms[formUuid].caseOperations?.[0]?.links?.push(peerLink);
			}),
			{
				...linkedVisit,
				links: [...linkedVisit.links, peerLink],
			},
		);
	});
});
