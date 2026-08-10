/**
 * Pure schemas and replay for bounded Design Contract, revision, and plan
 * authoring. A workspace operation admits complete identity-addressed items;
 * whole-graph validation remains the finalizer's job.
 */

import { z } from "zod";
import {
	buildSliceSchema,
	externalActionSchema,
	intentOwnershipEntrySchema,
} from "@/lib/agent/design/buildPlan";
import {
	acceptanceScenarioSchema,
	accessPolicySchema,
	architectureDecisionSchema,
	assumptionSchema,
	deferredRequirementSchema,
	designActorSchema,
	factDefinitionSchema,
	lifecycleTransitionSchema,
	lookupTableIntentSchema,
	navigationIntentSchema,
	openQuestionSchema,
	readModelSchema,
	recordConceptSchema,
	ruleIntentSchema,
	taskSchema,
} from "@/lib/agent/design/contract";
import { sourceClaimSchema } from "@/lib/agent/design/evidence";
import { designIdSchema } from "@/lib/agent/design/ids";
import { findingDispositionSchema } from "@/lib/agent/design/review";

export const DESIGN_ARTIFACT_KINDS = ["contract", "revision", "plan"] as const;
export type DesignArtifactKind = (typeof DESIGN_ARTIFACT_KINDS)[number];

export const MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS = 32;
export const MAX_DESIGN_WORKSPACE_INPUT_BYTES = 48 * 1024;
export const MAX_DESIGN_WORKSPACE_STEPS = 64;

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const artifactRefSchema = z
	.object({ id: z.string().uuid(), digest: sha256HexSchema })
	.strict();

export const designArtifactWorkspaceLineageSchema = z
	.object({
		schemaVersion: z.literal(1),
		artifactKind: z.enum(DESIGN_ARTIFACT_KINDS),
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
				message: "Only a revision workspace is bound to review artifacts.",
			});
		}
		if (lineage.artifactKind === "plan" && lineage.baseRevision === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["baseRevision"],
				message: "A plan workspace requires its accepted revision.",
			});
		}
	});
export type DesignArtifactWorkspaceLineage = z.infer<
	typeof designArtifactWorkspaceLineageSchema
>;

export const CONTRACT_COLLECTIONS = [
	"sourceClaims",
	"actors",
	"records",
	"facts",
	"rules",
	"tasks",
	"transitions",
	"readModels",
	"lookupIntents",
	"accessPolicies",
	"navigation",
	"decisions",
	"assumptions",
	"openQuestions",
	"acceptanceScenarios",
	"deferredRequirements",
] as const;
export type ContractCollection = (typeof CONTRACT_COLLECTIONS)[number];

export const PLAN_COLLECTIONS = [
	"slices",
	"externalActions",
	"intentOwnership",
] as const;
export type PlanCollection = (typeof PLAN_COLLECTIONS)[number];

export const WORKSPACE_COLLECTIONS = [
	...CONTRACT_COLLECTIONS,
	"dispositions",
	...PLAN_COLLECTIONS,
] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];

const contractRootPatchSchema = z
	.object({
		id: designIdSchema.optional(),
		title: z.string().min(1).optional(),
		objective: z.string().min(1).optional(),
		inScope: z.array(z.string().min(1)).optional(),
		outOfScope: z.array(z.string().min(1)).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, {
		message: "A root update must set at least one contract field.",
	});

function identityMutationSchema<const C extends string, T extends z.ZodTypeAny>(
	collection: C,
	itemSchema: T,
	identity: "id" | "claimId" | "findingId" | "intentId",
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
			const upsertIds = value.upserts.map(
				(item) => (item as Record<string, unknown>)[identity] as string,
			);
			const seen = new Set<string>();
			upsertIds.forEach((id, index) => {
				if (seen.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["upserts", index, identity],
						message: "An identity may be upserted only once in one stage.",
					});
				}
				seen.add(id);
			});
			const removed = new Set<string>();
			value.removeIds.forEach((id, index) => {
				if (removed.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["removeIds", index],
						message: "An identity may be removed only once in one stage.",
					});
				}
				if (seen.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["removeIds", index],
						message:
							"The same identity cannot be upserted and removed in one stage.",
					});
				}
				removed.add(id);
			});
		});
}

const contractCollectionMutationSchema = z.discriminatedUnion("collection", [
	identityMutationSchema("sourceClaims", sourceClaimSchema, "id"),
	identityMutationSchema("actors", designActorSchema, "id"),
	identityMutationSchema("records", recordConceptSchema, "id"),
	identityMutationSchema("facts", factDefinitionSchema, "id"),
	identityMutationSchema("rules", ruleIntentSchema, "id"),
	identityMutationSchema("tasks", taskSchema, "id"),
	identityMutationSchema("transitions", lifecycleTransitionSchema, "id"),
	identityMutationSchema("readModels", readModelSchema, "id"),
	identityMutationSchema("lookupIntents", lookupTableIntentSchema, "id"),
	identityMutationSchema("accessPolicies", accessPolicySchema, "id"),
	identityMutationSchema("navigation", navigationIntentSchema, "id"),
	identityMutationSchema("decisions", architectureDecisionSchema, "id"),
	identityMutationSchema("assumptions", assumptionSchema, "id"),
	identityMutationSchema("openQuestions", openQuestionSchema, "id"),
	identityMutationSchema("acceptanceScenarios", acceptanceScenarioSchema, "id"),
	identityMutationSchema(
		"deferredRequirements",
		deferredRequirementSchema,
		"claimId",
	),
]);

const dispositionMutationSchema = identityMutationSchema(
	"dispositions",
	findingDispositionSchema,
	"findingId",
);

const planCollectionMutationSchema = z.discriminatedUnion("collection", [
	identityMutationSchema("slices", buildSliceSchema, "id"),
	identityMutationSchema("externalActions", externalActionSchema, "id"),
	identityMutationSchema(
		"intentOwnership",
		intentOwnershipEntrySchema,
		"intentId",
	),
]);

function noRepeatedCollections(
	collections: readonly { collection: string }[],
	ctx: z.RefinementCtx,
) {
	const seen = new Set<string>();
	collections.forEach((entry, index) => {
		if (seen.has(entry.collection)) {
			ctx.addIssue({
				code: "custom",
				path: ["collections", index, "collection"],
				message: "A collection may appear only once in one stage.",
			});
		}
		seen.add(entry.collection);
	});
}

const contractStageBodySchema = z
	.object({
		root: contractRootPatchSchema.optional(),
		collections: z.array(contractCollectionMutationSchema).max(1),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.root === undefined && value.collections.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: [],
				message: "A contract stage must change the root or a collection.",
			});
		}
		noRepeatedCollections(value.collections, ctx);
	});

const revisionStageBodySchema = z
	.object({
		root: contractRootPatchSchema.optional(),
		collections: z.array(contractCollectionMutationSchema).max(1),
		dispositions: dispositionMutationSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.root === undefined &&
			value.collections.length === 0 &&
			value.dispositions === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: [],
				message:
					"A revision stage must change the contract or its dispositions.",
			});
		}
		noRepeatedCollections(value.collections, ctx);
	});

const planStageBodySchema = z
	.object({ collections: z.array(planCollectionMutationSchema).length(1) })
	.strict()
	.superRefine((value, ctx) => noRepeatedCollections(value.collections, ctx));

export const stageContractInputSchema = contractStageBodySchema.extend({
	expectedRevision: z.number().int().nonnegative(),
});
export const stageRevisionInputSchema = revisionStageBodySchema.extend({
	expectedRevision: z.number().int().nonnegative(),
});
export const stagePlanInputSchema = planStageBodySchema.extend({
	expectedRevision: z.number().int().nonnegative(),
});

export const designArtifactWorkspaceOperationSchema = z.discriminatedUnion(
	"kind",
	[
		contractStageBodySchema.extend({ kind: z.literal("contract") }),
		revisionStageBodySchema.extend({ kind: z.literal("revision") }),
		planStageBodySchema.extend({ kind: z.literal("plan") }),
	],
);
export type DesignArtifactWorkspaceOperation = z.infer<
	typeof designArtifactWorkspaceOperationSchema
>;

export const inspectDesignWorkspaceInputSchema = z
	.object({
		artifactKind: z.enum(DESIGN_ARTIFACT_KINDS),
		expectedRevision: z.number().int().nonnegative(),
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

export const finalizeDesignWorkspaceInputSchema = z
	.object({ expectedRevision: z.number().int().nonnegative() })
	.strict();

function identityFor(collection: WorkspaceCollection, item: unknown): string {
	const record = item as Record<string, unknown>;
	if (collection === "deferredRequirements") return record.claimId as string;
	if (collection === "dispositions") return record.findingId as string;
	if (collection === "intentOwnership") return record.intentId as string;
	return record.id as string;
}

function applyIdentityMutation(
	candidate: Record<string, unknown>,
	mutation: {
		collection: WorkspaceCollection;
		upserts: unknown[];
		removeIds: string[];
	},
) {
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
		const replacement = upserts.get(id);
		next.push(replacement ?? item);
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
	if (kind === "plan") {
		return { slices: [], externalActions: [], intentOwnership: [] };
	}
	if (kind === "revision") {
		if (baseContract === undefined) {
			throw new Error("A revision workspace requires its base contract.");
		}
		return { ...baseContract, dispositions: [] };
	}
	return {
		schemaVersion: 1,
		sourceClaims: [],
		actors: [],
		records: [],
		facts: [],
		rules: [],
		tasks: [],
		transitions: [],
		readModels: [],
		lookupIntents: [],
		accessPolicies: [],
		navigation: [],
		decisions: [],
		assumptions: [],
		openQuestions: [],
		acceptanceScenarios: [],
		deferredRequirements: [],
	};
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
		if (operation.kind !== args.kind) {
			throw new Error("A workspace step belongs to a different artifact kind.");
		}
		if (operation.kind === "contract" || operation.kind === "revision") {
			if (operation.root !== undefined)
				Object.assign(candidate, operation.root);
			for (const collection of operation.collections) {
				applyIdentityMutation(candidate, collection as never);
			}
			if (
				operation.kind === "revision" &&
				operation.dispositions !== undefined
			) {
				applyIdentityMutation(candidate, operation.dispositions as never);
			}
		} else {
			for (const collection of operation.collections) {
				applyIdentityMutation(candidate, collection as never);
			}
		}
	}
	return candidate;
}

export function designWorkspaceMutationCount(
	operation: DesignArtifactWorkspaceOperation,
): number {
	let count = 0;
	if (operation.kind === "contract" || operation.kind === "revision") {
		count += operation.root ? Object.keys(operation.root).length : 0;
		for (const collection of operation.collections) {
			count += collection.upserts.length + collection.removeIds.length;
		}
		if (operation.kind === "revision" && operation.dispositions) {
			count +=
				operation.dispositions.upserts.length +
				operation.dispositions.removeIds.length;
		}
	} else {
		for (const collection of operation.collections) {
			count += collection.upserts.length + collection.removeIds.length;
		}
	}
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
	if (mutations > MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS) {
		return `This stage contains ${mutations} item changes; submit at most ${MAX_DESIGN_WORKSPACE_ITEM_MUTATIONS} and continue in another stage.`;
	}
	const bytes = encodedJsonBytes(args.input);
	if (bytes > MAX_DESIGN_WORKSPACE_INPUT_BYTES) {
		return `This stage is ${bytes} bytes; keep each stage at or below ${MAX_DESIGN_WORKSPACE_INPUT_BYTES} bytes and continue in another stage.`;
	}
	return null;
}

export function workspaceCollectionNames(
	kind: DesignArtifactKind,
): readonly WorkspaceCollection[] {
	if (kind === "plan") return PLAN_COLLECTIONS;
	return kind === "revision"
		? [...CONTRACT_COLLECTIONS, "dispositions"]
		: CONTRACT_COLLECTIONS;
}

export function designWorkspaceCandidateSummary(
	kind: DesignArtifactKind,
	candidate: Record<string, unknown>,
) {
	const counts = Object.fromEntries(
		workspaceCollectionNames(kind).map((collection) => [
			collection,
			Array.isArray(candidate[collection]) ? candidate[collection].length : 0,
		]),
	);
	const missingRootFields =
		kind === "plan"
			? []
			: ["id", "title", "objective", "inScope", "outOfScope"].filter(
					(key) => candidate[key] === undefined,
				);
	return { counts, missingRootFields };
}

export function inspectDesignWorkspaceCandidate(args: {
	kind: DesignArtifactKind;
	candidate: Record<string, unknown>;
	sourceContract?: Record<string, unknown>;
	selection: z.infer<typeof inspectDesignWorkspaceInputSchema>["selection"];
}) {
	if (args.selection.kind === "summary") {
		return {
			kind: "summary" as const,
			...designWorkspaceCandidateSummary(args.kind, args.candidate),
		};
	}
	if (args.selection.kind === "root" || args.selection.kind === "sourceRoot") {
		const source = args.selection.kind === "sourceRoot";
		if (source && args.sourceContract === undefined) {
			throw new Error("This workspace has no immutable source contract.");
		}
		if (args.kind === "plan") {
			if (!source) return { kind: "root" as const, root: {} };
		}
		const candidate = source ? (args.sourceContract ?? {}) : args.candidate;
		return {
			kind: args.selection.kind,
			root: Object.fromEntries(
				["schemaVersion", "id", "title", "objective", "inScope", "outOfScope"]
					.filter((key) => candidate[key] !== undefined)
					.map((key) => [key, candidate[key]]),
			),
		};
	}
	const selection = args.selection;
	const source = selection.kind === "sourceCollection";
	if (source && args.sourceContract === undefined) {
		throw new Error("This workspace has no immutable source contract.");
	}
	const allowed = source
		? CONTRACT_COLLECTIONS
		: workspaceCollectionNames(args.kind);
	if (!allowed.includes(selection.collection)) {
		throw new Error("That collection does not belong to this artifact kind.");
	}
	const inspectedCandidate = source
		? (args.sourceContract ?? {})
		: args.candidate;
	const all = (inspectedCandidate[selection.collection] ?? []) as unknown[];
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
