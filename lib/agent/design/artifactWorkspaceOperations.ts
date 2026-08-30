/** Pure schemas and replay for bounded contract/revision workspaces.
 *
 * The provider sees semantic root/collection operations. Artifact kind and
 * optimistic workspace revision are server-owned persistence details. */

import { z } from "zod";
import {
	accessPolicySchema,
	appCharterSchema,
	architectureDecisionSchema,
	assumptionSchema,
	designActorSchema,
	designLookupTableSchema,
	externalRequirementSchema,
	formCompositionSchema,
	moduleCompositionSchema,
	navigationIntentSchema,
	openQuestionSchema,
	recordConceptSchema,
	workflowSchema,
	workListSchema,
} from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import { findingDispositionSchema } from "@/lib/agent/design/review";

export const DESIGN_ARTIFACT_KINDS = ["contract", "revision"] as const;
export type DesignArtifactKind = (typeof DESIGN_ARTIFACT_KINDS)[number];

export const MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS = 32;
export const MAX_DESIGN_WORKSPACE_INPUT_BYTES = 48 * 1024;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactRefSchema = z
	.object({ id: z.string().uuid(), digest: sha256HexSchema })
	.strict();

export const designArtifactWorkspaceLineageSchema = z
	.object({
		schemaVersion: z.literal(1),
		artifactKind: z.enum(DESIGN_ARTIFACT_KINDS),
		sourcePackageDigest: sha256HexSchema,
		baseRevision: artifactRefSchema.optional(),
		reviewArtifacts: z.array(artifactRefSchema),
	})
	.strict()
	.superRefine((lineage, ctx) => {
		if (lineage.artifactKind === "revision") {
			if (lineage.baseRevision === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["baseRevision"],
					message: "A revision workspace requires its reviewed draft.",
				});
			}
			if (lineage.reviewArtifacts.length === 0) {
				ctx.addIssue({
					code: "custom",
					path: ["reviewArtifacts"],
					message: "A revision workspace requires its persisted review.",
				});
			}
		} else if (lineage.reviewArtifacts.length > 0) {
			ctx.addIssue({
				code: "custom",
				path: ["reviewArtifacts"],
				message: "Only a revision workspace binds review artifacts.",
			});
		}
	});
export type DesignArtifactWorkspaceLineage = z.infer<
	typeof designArtifactWorkspaceLineageSchema
>;

export const CONTRACT_COLLECTIONS = [
	"actors",
	"records",
	"workflows",
	"lists",
	"access",
	"navigation",
	"moduleCompositions",
	"formCompositions",
	"lookupTables",
	"externalRequirements",
	"decisions",
	"assumptions",
	"openQuestions",
] as const;
export type ContractCollection = (typeof CONTRACT_COLLECTIONS)[number];
export const WORKSPACE_COLLECTIONS = [
	...CONTRACT_COLLECTIONS,
	"dispositions",
] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];

/** The stage grammar's charter IS the contract's charter — one schema, so
 * the two can never drift. */
export const setDesignRootInputSchema = z
	.object({
		schemaVersion: z.literal(2).optional(),
		id: designIdSchema.optional(),
		charter: appCharterSchema.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message:
			"A root update must set schema version 2, the contract id, or the complete charter.",
	});

function identityUpdateInputSchema<T extends z.ZodTypeAny>(
	itemSchema: T,
	identity: "id" | "findingId",
) {
	return z
		.object({
			upserts: z.array(itemSchema).max(MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS),
			removeIds: z
				.array(designIdSchema)
				.max(MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS),
		})
		.strict()
		.superRefine((value, ctx) => {
			if (value.upserts.length === 0 && value.removeIds.length === 0) {
				ctx.addIssue({
					code: "custom",
					path: [],
					message: "An update must upsert or remove an item.",
				});
			}
			const upserts = new Set<string>();
			value.upserts.forEach((item, index) => {
				const id = (item as Record<string, unknown>)[identity] as string;
				if (upserts.has(id))
					ctx.addIssue({
						code: "custom",
						path: ["upserts", index, identity],
						message: "An identity may be upserted only once in one call.",
					});
				upserts.add(id);
			});
			value.removeIds.forEach((id, index) => {
				if (upserts.has(id))
					ctx.addIssue({
						code: "custom",
						path: ["removeIds", index],
						message:
							"The same identity cannot be upserted and removed in one call.",
					});
			});
		});
}

/** Provider-facing semantic collection grammars. The tool name supplies the
 * collection, so the model never repeats a bookkeeping discriminator. */
export const designCollectionUpdateInputSchemas = {
	actors: identityUpdateInputSchema(designActorSchema, "id"),
	records: identityUpdateInputSchema(recordConceptSchema, "id"),
	workflows: identityUpdateInputSchema(workflowSchema, "id"),
	lists: identityUpdateInputSchema(workListSchema, "id"),
	access: identityUpdateInputSchema(accessPolicySchema, "id"),
	navigation: identityUpdateInputSchema(navigationIntentSchema, "id"),
	moduleCompositions: identityUpdateInputSchema(moduleCompositionSchema, "id"),
	formCompositions: identityUpdateInputSchema(formCompositionSchema, "id"),
	lookupTables: identityUpdateInputSchema(designLookupTableSchema, "id"),
	externalRequirements: identityUpdateInputSchema(
		externalRequirementSchema,
		"id",
	),
	decisions: identityUpdateInputSchema(architectureDecisionSchema, "id"),
	assumptions: identityUpdateInputSchema(assumptionSchema, "id"),
	openQuestions: identityUpdateInputSchema(openQuestionSchema, "id"),
} as const satisfies Record<ContractCollection, z.ZodTypeAny>;

export const updateFindingDispositionsInputSchema = identityUpdateInputSchema(
	findingDispositionSchema,
	"findingId",
);

function identityMutationSchema<const C extends string, T extends z.ZodTypeAny>(
	collection: C,
	itemSchema: T,
	identity: "id" | "findingId",
) {
	return z
		.object({
			collection: z.literal(collection),
			upserts: z.array(itemSchema).max(MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS),
			removeIds: z
				.array(designIdSchema)
				.max(MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS),
		})
		.strict()
		.superRefine((value, ctx) => {
			if (value.upserts.length === 0 && value.removeIds.length === 0) {
				ctx.addIssue({
					code: "custom",
					path: [],
					message: "A collection update must upsert or remove an item.",
				});
			}
			const upserts = new Set<string>();
			value.upserts.forEach((item, index) => {
				const id = (item as Record<string, unknown>)[identity] as string;
				if (upserts.has(id))
					ctx.addIssue({
						code: "custom",
						path: ["upserts", index, identity],
						message: "An identity may be upserted only once in one update.",
					});
				upserts.add(id);
			});
			value.removeIds.forEach((id, index) => {
				if (upserts.has(id))
					ctx.addIssue({
						code: "custom",
						path: ["removeIds", index],
						message:
							"The same identity cannot be upserted and removed in one update.",
					});
			});
		});
}

const contractCollectionMutationSchema = z.discriminatedUnion("collection", [
	identityMutationSchema("actors", designActorSchema, "id"),
	identityMutationSchema("records", recordConceptSchema, "id"),
	identityMutationSchema("workflows", workflowSchema, "id"),
	identityMutationSchema("lists", workListSchema, "id"),
	identityMutationSchema("access", accessPolicySchema, "id"),
	identityMutationSchema("navigation", navigationIntentSchema, "id"),
	identityMutationSchema("moduleCompositions", moduleCompositionSchema, "id"),
	identityMutationSchema("formCompositions", formCompositionSchema, "id"),
	identityMutationSchema("lookupTables", designLookupTableSchema, "id"),
	identityMutationSchema(
		"externalRequirements",
		externalRequirementSchema,
		"id",
	),
	identityMutationSchema("decisions", architectureDecisionSchema, "id"),
	identityMutationSchema("assumptions", assumptionSchema, "id"),
	identityMutationSchema("openQuestions", openQuestionSchema, "id"),
]);

const dispositionMutationSchema = identityMutationSchema(
	"dispositions",
	findingDispositionSchema,
	"findingId",
);

const contractStageBodySchema = z
	.object({
		root: setDesignRootInputSchema.optional(),
		collections: z.array(contractCollectionMutationSchema).max(1),
	})
	.strict()
	.refine((value) => value.root !== undefined || value.collections.length > 0, {
		message: "A contract stage must change the root or one collection.",
	});

const revisionStageBodySchema = z
	.object({
		root: setDesignRootInputSchema.optional(),
		collections: z.array(contractCollectionMutationSchema).max(1),
		dispositions: dispositionMutationSchema.optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.root !== undefined ||
			value.collections.length > 0 ||
			value.dispositions !== undefined,
		{
			message:
				"A revision stage must change the design or its blocking dispositions.",
		},
	);

export const designArtifactWorkspaceOperationSchema = z.discriminatedUnion(
	"kind",
	[
		contractStageBodySchema.extend({ kind: z.literal("contract") }),
		revisionStageBodySchema.extend({ kind: z.literal("revision") }),
	],
);
export type DesignArtifactWorkspaceOperation = z.infer<
	typeof designArtifactWorkspaceOperationSchema
>;

export const inspectDesignInputSchema = z
	.object({
		selection: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("summary") }).strict(),
			z.object({ kind: z.literal("root") }).strict(),
			z.object({ kind: z.literal("sourceRoot") }).strict(),
			z
				.object({
					kind: z.literal("collection"),
					collection: z.enum(WORKSPACE_COLLECTIONS),
					ids: z.array(designIdSchema).max(20),
					offset: z.number().int().nonnegative(),
					limit: z.number().int().min(1).max(20),
				})
				.strict(),
			z
				.object({
					kind: z.literal("sourceCollection"),
					collection: z.enum(CONTRACT_COLLECTIONS),
					ids: z.array(designIdSchema).max(20),
					offset: z.number().int().nonnegative(),
					limit: z.number().int().min(1).max(20),
				})
				.strict(),
		]),
	})
	.strict();

export const finishDesignInputSchema = z.object({}).strict();

function identityFor(collection: WorkspaceCollection, item: unknown): string {
	const record = item as Record<string, unknown>;
	return (
		collection === "dispositions" ? record.findingId : record.id
	) as string;
}

function applyIdentityMutation(
	candidate: Record<string, unknown>,
	mutation: {
		collection: WorkspaceCollection;
		upserts: unknown[];
		removeIds: string[];
	},
): void {
	const prior = Array.isArray(candidate[mutation.collection])
		? [...(candidate[mutation.collection] as unknown[])]
		: [];
	const removals = new Set(mutation.removeIds);
	const upserts = new Map(
		mutation.upserts.map((item) => [
			identityFor(mutation.collection, item),
			item,
		]),
	);
	const next: unknown[] = [];
	for (const item of prior) {
		const id = identityFor(mutation.collection, item);
		if (removals.has(id)) continue;
		next.push(upserts.get(id) ?? item);
		upserts.delete(id);
	}
	for (const item of mutation.upserts) {
		const id = identityFor(mutation.collection, item);
		if (upserts.has(id)) {
			next.push(item);
			upserts.delete(id);
		}
	}
	candidate[mutation.collection] = next;
}

export function initialDesignWorkspaceCandidate(
	kind: DesignArtifactKind,
	baseContract?: Record<string, unknown>,
): Record<string, unknown> {
	if (kind === "revision") {
		if (baseContract === undefined)
			throw new Error("A revision workspace requires its base contract.");
		return { ...baseContract, dispositions: [] };
	}
	return baseContract === undefined
		? {
				schemaVersion: 2,
				actors: [],
				records: [],
				workflows: [],
				lists: [],
				access: [],
				navigation: [],
				moduleCompositions: [],
				formCompositions: [],
				lookupTables: [],
				externalRequirements: [],
				decisions: [],
				assumptions: [],
				openQuestions: [],
			}
		: { ...baseContract };
}

export function replayDesignWorkspace(args: {
	kind: DesignArtifactKind;
	baseContract?: Record<string, unknown>;
	operations: readonly DesignArtifactWorkspaceOperation[];
}): Record<string, unknown> {
	const candidate = initialDesignWorkspaceCandidate(
		args.kind,
		args.baseContract,
	);
	for (const operation of args.operations) {
		if (operation.kind !== args.kind)
			throw new Error("A workspace step belongs to a different artifact kind.");
		if (operation.root !== undefined) {
			Object.assign(candidate, operation.root);
			if (
				operation.root.schemaVersion === 2 &&
				!Array.isArray(candidate.lookupTables)
			)
				candidate.lookupTables = [];
		}
		for (const collection of operation.collections)
			applyIdentityMutation(candidate, collection as never);
		if (operation.kind === "revision" && operation.dispositions !== undefined)
			applyIdentityMutation(candidate, operation.dispositions as never);
	}
	return candidate;
}

export function designWorkspaceMutationCount(
	operation: DesignArtifactWorkspaceOperation,
): number {
	let count = operation.root ? Object.keys(operation.root).length : 0;
	for (const collection of operation.collections)
		count += collection.upserts.length + collection.removeIds.length;
	if (operation.kind === "revision" && operation.dispositions)
		count +=
			operation.dispositions.upserts.length +
			operation.dispositions.removeIds.length;
	return count;
}

export function encodedJsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function designWorkspaceBoundError(args: {
	input: unknown;
	operation: DesignArtifactWorkspaceOperation;
}): string | null {
	const mutations = designWorkspaceMutationCount(args.operation);
	if (mutations > MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS)
		return `This call contains ${mutations} item changes; submit at most ${MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS} and continue in another semantic call.`;
	const bytes = encodedJsonBytes(args.input);
	return bytes > MAX_DESIGN_WORKSPACE_INPUT_BYTES
		? `This call is ${bytes} bytes; keep each semantic call at or below ${MAX_DESIGN_WORKSPACE_INPUT_BYTES} bytes and continue in another call.`
		: null;
}

export function workspaceCollectionNames(
	kind: DesignArtifactKind,
): readonly WorkspaceCollection[] {
	return kind === "revision"
		? [...CONTRACT_COLLECTIONS, "dispositions"]
		: CONTRACT_COLLECTIONS;
}

export function designWorkspaceCandidateSummary(
	kind: DesignArtifactKind,
	candidate: Record<string, unknown>,
) {
	return {
		counts: Object.fromEntries(
			workspaceCollectionNames(kind).map((collection) => [
				collection,
				Array.isArray(candidate[collection]) ? candidate[collection].length : 0,
			]),
		),
		missingRootFields: ["id", "charter"].filter(
			(key) => candidate[key] === undefined,
		),
	};
}

export function inspectDesignWorkspaceCandidate(args: {
	kind: DesignArtifactKind;
	candidate: Record<string, unknown>;
	sourceContract?: Record<string, unknown>;
	selection: z.infer<typeof inspectDesignInputSchema>["selection"];
}) {
	if (args.selection.kind === "summary")
		return {
			kind: "summary" as const,
			...designWorkspaceCandidateSummary(args.kind, args.candidate),
		};
	if (args.selection.kind === "root" || args.selection.kind === "sourceRoot") {
		const candidate =
			args.selection.kind === "sourceRoot"
				? args.sourceContract
				: args.candidate;
		if (candidate === undefined)
			throw new Error("This workspace has no immutable source contract.");
		return {
			kind: args.selection.kind,
			root: Object.fromEntries(
				["schemaVersion", "id", "charter"]
					.filter((key) => candidate[key] !== undefined)
					.map((key) => [key, candidate[key]]),
			),
		};
	}
	if (
		args.selection.kind !== "collection" &&
		args.selection.kind !== "sourceCollection"
	) {
		throw new Error("Unknown workspace inspection selection.");
	}
	const selection = args.selection as Extract<
		z.infer<typeof inspectDesignInputSchema>["selection"],
		{ kind: "collection" | "sourceCollection" }
	>;
	const source = selection.kind === "sourceCollection";
	const candidate = source ? args.sourceContract : args.candidate;
	if (candidate === undefined)
		throw new Error("This workspace has no immutable source contract.");
	const all = (candidate[selection.collection] ?? []) as unknown[];
	const filtered =
		selection.ids.length === 0
			? all
			: all.filter((item) =>
					selection.ids.includes(
						identityFor(selection.collection, item) as never,
					),
				);
	const items = filtered.slice(
		selection.offset,
		selection.offset + selection.limit,
	);
	return {
		kind: selection.kind,
		collection: selection.collection,
		items,
		total: filtered.length,
		offset: selection.offset,
		truncated: selection.offset + items.length < filtered.length,
	};
}
