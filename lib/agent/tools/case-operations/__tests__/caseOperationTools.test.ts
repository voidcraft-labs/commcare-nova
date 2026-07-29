import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import {
	BlueprintCommitRejectedError,
	batchTargetsMissing,
} from "@/lib/db/commitGuard";
import type { Mutation } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	LookupColumnId,
	LookupTableId,
	Uuid,
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

const TEXT = testUuid("44444444-4444-4444-8444-444444444444");
const WORKER_PROPERTY = testUuid("55555555-5555-4555-8555-555555555555");
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
	readonly moduleUuid: ReturnType<typeof testUuid>;
	readonly formUuid: ReturnType<typeof testUuid>;
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
	return { doc, moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
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
				opUuid: testUuid("11111111-1111-4111-8111-111111111111"),
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
		// Schema-level: the address is two opaque identities, so any pair does.
		const { moduleUuid, formUuid } = fixture();
		const wire = wireToolSchema(addCaseOperationsInputSchema);
		const json = JSON.stringify(await wire.jsonSchema);
		expect(json).toContain("Author ValueExpression AST node");
		expect(json).not.toContain("table-column");
		expect(json).not.toContain("table-lookup");

		const valid = await wire.validate?.({
			moduleUuid,
			formUuid,
			operations: [createVisit],
		});
		expect(valid?.success).toBe(true);
		const rejected = await wire.validate?.({
			moduleUuid,
			formUuid,
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
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const result = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
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
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		const read = await getCaseOperationsTool.execute(
			{ moduleUuid, formUuid },
			ctx,
			added.newDoc,
		);
		// The rule is about the OPERATIONS: no storage identity may reach an
		// author-facing expression, whose leaves the caller has to read and
		// write. The envelope's address is the identity the caller supplied and
		// is deliberately echoed, so it is not part of that claim.
		const json = JSON.stringify(
			(read.data as { operations: readonly unknown[] }).operations,
		);
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
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit],
			},
			ctx,
			doc,
		);
		const result = await updateCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
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

	it("retargets across case types atomically on the shared chat and MCP tool", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const desired = {
			...updateVisit,
			caseType: "patient",
			target: { kind: "session" as const },
		};
		const result = await updateCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationId: "tag_visit",
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
					uuid: expect.any(String),
					patch: {
						caseType: "patient",
						target: { kind: "session" },
					},
				},
			}),
		]);
		expect(
			result.newDoc.forms[formUuid].caseOperations?.find(
				(operation) => operation.id === "tag_visit",
			),
		).toMatchObject({
			caseType: "patient",
			target: { kind: "session" },
		});
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
					uuid: testUuid("10000000-0000-4000-8000-000000000001"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000002"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000003"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000004"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000005"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000006"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000007"),
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
					uuid: testUuid("10000000-0000-4000-8000-000000000008"),
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
			const { doc, moduleUuid, formUuid } = fixture();
			const operation = { ...scenario.operation, order: "a" };
			const safePeer: CaseOperation = {
				uuid: testUuid("10000000-0000-4000-8000-000000000099"),
				id: "safe_peer",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
			};
			doc.forms[formUuid].caseOperations = [operation, safePeer];
			const { ctx, recordMutations } = makeStubToolContext();
			const read = await getCaseOperationsTool.execute(
				{ moduleUuid, formUuid },
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
					moduleUuid,
					formUuid,
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

			const removed = await removeCaseOperationTool.execute(
				{
					moduleUuid,
					formUuid,
					operationId: operation.id,
				},
				ctx,
				doc,
			);
			expect(removed.result, scenario.slot).toEqual(
				expect.objectContaining({
					error: expect.stringContaining(
						"uses lookup-table logic that Nova preserves but cannot safely edit from this surface",
					),
				}),
			);
			expect(removed.mutations, scenario.slot).toEqual([]);
			expect(removed.newDoc, scenario.slot).toBe(doc);
			expect(
				removed.newDoc.forms[formUuid].caseOperations?.[0],
				scenario.slot,
			).toEqual(operation);
			expect(recordMutations, scenario.slot).not.toHaveBeenCalled();

			const moved = await moveCaseOperationTool.execute(
				{
					moduleUuid,
					formUuid,
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
			expect(movedOperation, scenario.slot).toEqual(operation);
			expect(JSON.stringify(moved.mutations), scenario.slot).not.toMatch(
				/table-column|table-lookup/,
			);
		}
	});

	it("refuses removing or moving a producer past its dependent", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();

		const removed = await removeCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
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
				moduleUuid,
				formUuid,
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
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx, recordMutations } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit],
			},
			ctx,
			doc,
		);
		recordMutations.mockClear();
		const moved = await moveCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
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

	it("surfaces authoritative operation/write/link races instead of reporting success", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
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
				moduleUuid,
				formUuid,
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
						moduleUuid,
						formUuid,
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

describe("worker information round-trips through the author boundary", () => {
	// The canonical term union has seven arms. A missing one is not
	// "unauthorable": it survives the projector untouched, leaking the
	// storage UUID this boundary promises never to return, and then fails
	// the union parse on the way back in — so a read cannot be edited.
	const workerValue = {
		kind: "term" as const,
		term: { kind: "session-user-property" as const, slug: "district" },
	};

	function docWithWorkerProperty(): ReturnType<typeof fixture> {
		const built = fixture();
		const doc = produce(built.doc, (draft: BlueprintDoc) => {
			(draft as { userProperties?: Record<string, unknown> }).userProperties = {
				[WORKER_PROPERTY]: {
					uuid: WORKER_PROPERTY,
					slug: "district",
					label: "District",
				},
			};
		});
		return { ...built, doc };
	}

	it("reads back a saved worker-information value as its saved key, then accepts it", async () => {
		const { doc, moduleUuid, formUuid } = docWithWorkerProperty();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [
					{
						...createVisit,
						writes: [{ property: "source_id", value: workerValue }],
					},
				],
			},
			ctx,
			doc,
		);
		expect(added.result).toEqual(
			expect.objectContaining({ message: expect.any(String) }),
		);

		const read = await getCaseOperationsTool.execute(
			{ moduleUuid, formUuid },
			ctx,
			added.newDoc,
		);
		const json = JSON.stringify(read.data);
		expect(json).toContain('"slug":"district"');
		expect(json).not.toContain(WORKER_PROPERTY);
		expect(json).not.toContain("userPropertyUuid");

		// The exact projection the read returned goes straight back in.
		const operations =
			"operations" in read.data ? read.data.operations : undefined;
		const projected = operations?.[0] as Record<string, unknown>;
		const updated = await updateCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationId: "create_visit",
				operation: { ...projected, id: "create_encounter" } as never,
			},
			ctx,
			added.newDoc,
		);
		expect(updated.result).not.toHaveProperty("error");
	});

	it("names the saved keys it knows when the slug is not set up", async () => {
		const { doc, moduleUuid, formUuid } = docWithWorkerProperty();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [
					{
						...createVisit,
						writes: [
							{
								property: "source_id",
								value: {
									kind: "term" as const,
									term: {
										kind: "session-user-property" as const,
										slug: "not_set_up",
									},
								},
							},
						],
					},
				],
			},
			ctx,
			doc,
		);
		expect(added.result).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("district"),
			}),
		);
	});
});

describe("dependency refusals say which constraint refused", () => {
	// A `target-type` blocker holds no reference at all — it would simply be
	// left acting on a kind of case the removed/moved change is what
	// establishes. "Retarget those references" sends the agent looking for
	// an edge that does not exist, which is why the planner reports the kind.
	//
	// The chain needs a PORTABLE retype (every property retained at the same
	// type), so it gets its own two-type fixture rather than bending the
	// shared one.
	/** Identity of the one module/form this fixture builds, for the address. */
	function retypeAddress(doc: BlueprintDoc): {
		moduleUuid: Uuid;
		formUuid: Uuid;
	} {
		const moduleUuid = doc.moduleOrder[0];
		return { moduleUuid, formUuid: doc.formOrder[moduleUuid][0] };
	}

	function retypeFixture(): BlueprintDoc {
		return buildDoc({
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
					id: "leads",
					name: "Leads",
					caseType: "lead",
					forms: [
						{
							id: "edit",
							name: "Edit",
							type: "followup",
							fields: [
								f({
									uuid: testUuid("66666666-6666-4666-8666-666666666666"),
									kind: "text",
									id: "note",
									label: "Note",
								}),
							],
						},
					],
				},
			],
		});
	}

	const noteValue = {
		kind: "term" as const,
		term: { kind: "field" as const, path: "note" },
	};
	const retypeLead = {
		id: "retype_lead",
		action: "update" as const,
		caseType: "lead",
		target: { kind: "session" as const },
		retype: "lead_copy",
	};
	const tagLead = {
		id: "tag_lead",
		action: "update" as const,
		caseType: "lead_copy",
		target: { kind: "session" as const },
		writes: [{ property: "note", value: noteValue }],
	};

	async function withRetypeChain() {
		const { ctx, recordMutations } = makeStubToolContext();
		const base = retypeFixture();
		const { moduleUuid, formUuid } = retypeAddress(base);
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [retypeLead, tagLead],
			},
			ctx,
			base,
		);
		expect(added.result).not.toHaveProperty("error");
		recordMutations.mockClear();
		return { ctx, doc: added.newDoc, recordMutations, moduleUuid, formUuid };
	}

	it("does not tell the agent to retarget a reference that is a type dependency", async () => {
		const { ctx, doc, recordMutations, moduleUuid, formUuid } =
			await withRetypeChain();

		const removed = await removeCaseOperationTool.execute(
			{ moduleUuid, formUuid, operationId: "retype_lead" },
			ctx,
			doc,
		);
		const removeError = (removed.result as { error: string }).error;
		expect(removeError).toContain("kind of case");
		expect(removeError).toContain("tag_lead");
		expect(removeError).not.toContain("uses its result");

		const moved = await moveCaseOperationTool.execute(
			{
				moduleUuid,
				formUuid,
				operationId: "retype_lead",
				index: 1,
			},
			ctx,
			doc,
		);
		const moveError = (moved.result as { error: string }).error;
		expect(moveError).toContain("kind of case");
		expect(moveError).not.toContain("reference");
		expect(recordMutations).not.toHaveBeenCalled();
	});

	it("still says 'reference' when one is what breaks", async () => {
		const { doc, moduleUuid, formUuid } = fixture();
		const { ctx } = makeStubToolContext();
		const added = await addCaseOperationsTool.execute(
			{
				moduleUuid,
				formUuid,
				operations: [createVisit, updateVisit],
			},
			ctx,
			doc,
		);
		const removed = await removeCaseOperationTool.execute(
			{ moduleUuid, formUuid, operationId: "create_visit" },
			ctx,
			added.newDoc,
		);
		const error = (removed.result as { error: string }).error;
		expect(error).toContain("uses its result");
		expect(error).not.toContain("kind of case");
	});
});
