/** Complete semantic tool payloads through the strict handle grammar and the
 * actual null/handle-to-canonical parse seam. Offline JSON-schema admission
 * does not prove a provider's constrained decoder or durable workspace write. */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { makeContract } from "@/lib/agent/design/__tests__/fixtures";
import {
	designCollectionUpdateInputSchemas,
	inspectDesignInputSchema,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	designToolWireSchema,
	inspectProjectDataInputSchema,
	resolveDesignWorkspaceHandles,
} from "@/lib/agent/design/loop/tools";
import {
	strictWireJsonSchema,
	stripNullProperties,
} from "@/lib/agent/strictStructuredOutput";

const session = "00000000-0000-4000-8000-000000000002";
const uuid = "00000000-0000-4000-8000-000000000010";
const lookup = "018f0000-0000-7000-8000-000000000001";
const handle = (name: string) => ({ handle: `@${name}` });
const actor = { ...makeContract().actors[0], id: handle("worker") };
function recordInput(
	parentRecordId: unknown = null,
	choiceSource: unknown = null,
) {
	return {
		upserts: [
			{
				id: handle("patient"),
				name: "Patient",
				purpose: "Track care",
				parentRecordId,
				relationshipMeaning:
					parentRecordId === null ? null : "Patient belongs to a household",
				lifecycleStates: ["active"],
				properties: [
					{
						id: handle("risk"),
						name: "Risk",
						meaning: "Patient priority",
						dataShape: choiceSource === null ? "text" : "single-choice",
						sensitivity: "ordinary",
						requiredWhen: null,
						choiceValues: null,
						choiceSource,
					},
				],
			},
		],
		removeIds: [],
	};
}
function validate(schema: z.ZodType, input: unknown, handles = true) {
	const json = handles
		? designToolWireSchema(schema)
		: strictWireJsonSchema(schema);
	const checker = new Ajv({ strict: false }).compile(json as object);
	const valid = checker(JSON.parse(JSON.stringify(input)));
	return { valid, errors: checker.errors };
}
function expectWire(schema: z.ZodType, input: unknown, handles = true) {
	const result = validate(schema, input, handles);
	expect(result.valid, JSON.stringify(result.errors)).toBe(true);
}
function canonical<T>(schema: z.ZodType<T>, input: unknown): T {
	return schema.parse(
		stripNullProperties(resolveDesignWorkspaceHandles(input, session)),
	);
}

describe("strict semantic design payloads", () => {
	it("admits a complete actor update and removal, then resolves the same handle consistently", () => {
		const input = { upserts: [actor], removeIds: [handle("former_worker")] };
		expectWire(designCollectionUpdateInputSchemas.actors, input);
		const result = canonical(designCollectionUpdateInputSchemas.actors, input);
		expect(result.upserts[0]).toEqual({
			...makeContract().actors[0],
			id: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(result.removeIds).toHaveLength(1);
		expect(result.upserts[0].id).not.toBe(result.removeIds[0]);
		expect(
			canonical(
				designCollectionUpdateInputSchemas.actors,
				JSON.parse(JSON.stringify(input)),
			),
		).toEqual(result);
		expect(input.upserts[0].id).toEqual(handle("worker"));
	});
	it.each([null, uuid, handle("household")])(
		"preserves optional parent reference %j alongside nested property identities",
		(parent) => {
			const input = recordInput(parent);
			expectWire(designCollectionUpdateInputSchemas.records, input);
			const result = canonical(
				designCollectionUpdateInputSchemas.records,
				input,
			).upserts[0];
			expect(result.parentRecordId).toEqual(
				parent === null
					? undefined
					: typeof parent === "string"
						? parent
						: resolveDesignWorkspaceHandles(parent, session),
			);
			expect(result.properties).toEqual([
				{
					id: resolveDesignWorkspaceHandles(handle("risk"), session),
					name: "Risk",
					meaning: "Patient priority",
					dataShape: "text",
					sensitivity: "ordinary",
				},
			]);
		},
	);
	it("expresses nullable root members and charter workflow references in one update", () => {
		const input = {
			schemaVersion: 1,
			id: handle("contract"),
			charter: {
				...makeContract().charter,
				includedWorkflowIds: [handle("register")],
				initialWorkflowId: handle("register"),
				localization: null,
			},
		};
		expectWire(setDesignRootInputSchema, input);
		const result = canonical(setDesignRootInputSchema, input);
		expect(result.charter?.initialWorkflowId).toBe(
			result.charter?.includedWorkflowIds[0],
		);
		expect(result.charter?.localization).toBeUndefined();
		expectWire(setDesignRootInputSchema, {
			schemaVersion: null,
			id: handle("contract"),
			charter: null,
		});
		expect(
			canonical(setDesignRootInputSchema, {
				schemaVersion: null,
				id: handle("contract"),
				charter: null,
			}),
		).toEqual({
			id: resolveDesignWorkspaceHandles(handle("contract"), session),
		});
	});
	it.each(["collection", "sourceCollection"])(
		"admits bounded %s reads by semantic handle",
		(kind) => {
			const input = {
				selection: {
					kind,
					collection: "records",
					ids: [handle("patient")],
					offset: 0,
					limit: 20,
				},
			};
			expectWire(inspectDesignInputSchema, input);
			expect(canonical(inspectDesignInputSchema, input)).toEqual({
				selection: {
					...input.selection,
					ids: [resolveDesignWorkspaceHandles(handle("patient"), session)],
				},
			});
			expect(
				validate(inspectDesignInputSchema, {
					selection: { ...input.selection, limit: 21 },
				}).valid,
			).toBe(false);
		},
	);
	it.each(["accepted", "rejected", "deferred"])(
		"admits a %s finding disposition without workspace metadata",
		(status) => {
			const input = {
				upserts: [
					{
						findingId: handle("finding"),
						status,
						rationale: "The recorded design explains this decision.",
					},
				],
				removeIds: [],
			};
			expectWire(updateFindingDispositionsInputSchema, input);
			expect(canonical(updateFindingDispositionsInputSchema, input)).toEqual({
				...input,
				upserts: [
					{
						...input.upserts[0],
						findingId: resolveDesignWorkspaceHandles(
							handle("finding"),
							session,
						),
					},
				],
			});
			for (const extra of [
				{ expectedRevision: 1 },
				{ artifactKind: "revision" },
			])
				expect(
					validate(updateFindingDispositionsInputSchema, { ...input, ...extra })
						.valid,
				).toBe(false);
		},
	);
	it.each([
		null,
		{ handle: "worker" },
		{ handle: "@worker", extra: true },
		[],
		12,
	])(
		"rejects invalid required declaration %j in an otherwise valid payload",
		(id) => {
			const input = { upserts: [actor], removeIds: [] };
			expectWire(designCollectionUpdateInputSchemas.actors, input);
			expect(
				validate(designCollectionUpdateInputSchemas.actors, {
					...input,
					upserts: [{ ...actor, id }],
				}).valid,
			).toBe(false);
		},
	);
	it("rejects omitted strict fields although canonical input can omit optional fields", () => {
		expect(setDesignRootInputSchema.parse({ id: uuid })).toEqual({ id: uuid });
		expect(
			validate(setDesignRootInputSchema, { id: handle("contract") }).valid,
		).toBe(false);
		const input = recordInput();
		const { parentRecordId: _parent, ...missing } = input.upserts[0];
		expect(
			validate(designCollectionUpdateInputSchemas.records, {
				...input,
				upserts: [missing],
			}).valid,
		).toBe(false);
	});
	it("retains the canonical-only persisted schema after projection", () => {
		designToolWireSchema(designCollectionUpdateInputSchemas.actors);
		expect(
			designCollectionUpdateInputSchemas.actors.safeParse({
				upserts: [actor],
				removeIds: [],
			}).success,
		).toBe(false);
		const input = { upserts: [{ ...actor, id: uuid }], removeIds: [] };
		expectWire(designCollectionUpdateInputSchemas.actors, input);
		expect(designCollectionUpdateInputSchemas.actors.parse(input)).toEqual(
			input,
		);
	});
});

describe("lookup identity domains", () => {
	it("widens designed lookup IDs but keeps existing Project table and column UUIDs canonical", () => {
		const designed = {
			kind: "designed-project-lookup",
			tableId: handle("risks"),
			valueColumnId: handle("value"),
			labelColumnId: handle("label"),
		};
		expectWire(
			designCollectionUpdateInputSchemas.records,
			recordInput(null, designed),
		);
		expect(
			canonical(
				designCollectionUpdateInputSchemas.records,
				recordInput(null, designed),
			).upserts[0].properties[0].choiceSource,
		).toEqual(resolveDesignWorkspaceHandles(designed, session));
		const existing = {
			kind: "existing-project-lookup",
			tableId: lookup,
			valueColumnId: lookup,
			labelColumnId: lookup,
			inspection: {
				tableRevision: "7",
				tableName: "Risks",
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
		expectWire(
			designCollectionUpdateInputSchemas.records,
			recordInput(null, existing),
		);
		expect(
			canonical(
				designCollectionUpdateInputSchemas.records,
				recordInput(null, existing),
			).upserts[0].properties[0].choiceSource,
		).toEqual(existing);
		for (const key of ["tableId", "valueColumnId", "labelColumnId"])
			expect(
				validate(
					designCollectionUpdateInputSchemas.records,
					recordInput(null, { ...existing, [key]: handle("external") }),
				).valid,
			).toBe(false);
	});
	it("keeps Project inspection canonical and enforces semantic projection requirements after null normalization", () => {
		const input = {
			tableId: lookup,
			query: null,
			columnIds: null,
			choiceProjection: { valueColumnId: lookup, labelColumnId: lookup },
			cursor: "next-page",
		};
		expectWire(inspectProjectDataInputSchema, input, false);
		expect(
			inspectProjectDataInputSchema.parse(stripNullProperties(input)),
		).toEqual({
			tableId: lookup,
			choiceProjection: input.choiceProjection,
			cursor: "next-page",
		});
		expect(
			validate(
				inspectProjectDataInputSchema,
				{ ...input, tableId: handle("table") },
				false,
			).valid,
		).toBe(false);
		expect(
			inspectProjectDataInputSchema.safeParse({
				tableId: lookup,
				choiceProjection: input.choiceProjection,
				columnIds: [lookup],
			}).success,
		).toBe(false);
		expect(
			inspectProjectDataInputSchema.safeParse({ query: "active" }).success,
		).toBe(false);
		expectWire(
			inspectProjectDataInputSchema,
			{
				tableId: null,
				query: null,
				columnIds: null,
				choiceProjection: null,
				cursor: null,
			},
			false,
		);
	});
});
