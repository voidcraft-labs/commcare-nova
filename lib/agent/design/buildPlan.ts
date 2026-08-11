/**
 * Deterministic BuildPlan v1.
 *
 * Planning is a compiler pass over an accepted lean Design Contract, not a
 * model-authored artifact. The server creates one task-complete slice per
 * workflow, derives dependencies and external actions, and assigns every
 * other semantic element to the earliest workflow that creates, writes,
 * exposes, or protects it. Construction groups describe real units of work;
 * they are the executor's coverage identities and replace mirrored intent
 * ownership/lowering tables.
 */

import { z } from "zod";
import {
	type AppDesignContract,
	designConstructionIssues,
} from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const blueprintAreaSchema = z.enum([
	"app",
	"case-catalog",
	"users",
	"organization-shape",
	"navigation",
	"case-list",
	"forms",
	"case-operations",
	"media-references",
	"automations",
]);
export type BlueprintArea = z.infer<typeof blueprintAreaSchema>;

export const designElementRefSchema = z
	.object({
		kind: z.enum([
			"workflow",
			"actor",
			"record",
			"property",
			"list",
			"access",
			"navigation",
			"external-requirement",
		]),
		id: designIdSchema,
	})
	.strict();
export type DesignElementRef = z.infer<typeof designElementRefSchema>;

export const constructionGroupSchema = z
	.object({
		id: designIdSchema,
		workflowId: designIdSchema,
		name: z.string().min(1),
		kind: z.enum([
			"foundation",
			"capture",
			"workflow",
			"work-queue",
			"access-navigation",
		]),
		elements: z.array(designElementRefSchema).min(1),
		blueprintAreas: z.array(blueprintAreaSchema).min(1),
	})
	.strict();
export type ConstructionGroup = z.infer<typeof constructionGroupSchema>;

/** External requirements are plan actions, not Blueprint mutations. Persisted
 * v1 plans may still carry an all-external legacy group; readers accept it but
 * the executor and commit gate do not treat it as construction coverage. */
export function isExecutableConstructionGroup(
	group: ConstructionGroup,
): boolean {
	return group.elements.some(
		(element) => element.kind !== "external-requirement",
	);
}

export const externalActionSchema = z
	.object({
		id: designIdSchema,
		requirementId: designIdSchema,
		kind: z.enum([
			"existing-reference",
			"user-prerequisite",
			"runtime-readiness",
			"deployment-readiness",
			"unsupported",
		]),
		timing: z.enum([
			"before-materialization",
			"before-slice",
			"after-slice",
			"manual-setup",
		]),
		requiredFor: z.enum(["construction", "runtime", "deployment", "optional"]),
		description: z.string().min(1),
		/** Durable evidence the orchestrator can require before construction. */
		completionEvidence: z.string().min(1),
	})
	.strict();
export type ExternalAction = z.infer<typeof externalActionSchema>;

export const buildSliceRiskSchema = z.enum([
	"ordinary",
	"cross-record",
	"external-effect",
	"data-migration",
]);
export type BuildSliceRisk = z.infer<typeof buildSliceRiskSchema>;

export const buildSliceSchema = z
	.object({
		id: designIdSchema,
		workflowId: designIdSchema,
		name: z.string().min(1),
		goal: z.string().min(1),
		prerequisiteSliceIds: z.array(designIdSchema),
		constructionGroups: z.array(constructionGroupSchema).min(1),
		externalActionIds: z.array(designIdSchema),
		risk: buildSliceRiskSchema,
		role: z.enum(["materialization-root", "ordinary", "exclusive"]),
	})
	.strict();
export type BuildSlice = z.infer<typeof buildSliceSchema>;

const buildPlanBaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: sha256HexSchema,
		id: z.string().uuid(),
		slices: z.array(buildSliceSchema).min(1),
		externalActions: z.array(externalActionSchema),
	})
	.strict();
export type BuildPlan = z.infer<typeof buildPlanBaseSchema>;

function validatePlan(plan: BuildPlan, ctx: z.RefinementCtx): void {
	const sliceIds = new Set<string>();
	const workflowIds = new Set<string>();
	const groupIds = new Set<string>();
	let roots = 0;
	plan.slices.forEach((slice, sliceIndex) => {
		if (sliceIds.has(slice.id)) {
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "id"],
				message: "Slice ids must be unique.",
			});
		}
		sliceIds.add(slice.id);
		if (workflowIds.has(slice.workflowId)) {
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "workflowId"],
				message: "Each workflow must have exactly one slice.",
			});
		}
		workflowIds.add(slice.workflowId);
		if (slice.role === "materialization-root") roots += 1;
		slice.constructionGroups.forEach((group, groupIndex) => {
			if (group.workflowId !== slice.workflowId) {
				ctx.addIssue({
					code: "custom",
					path: [
						"slices",
						sliceIndex,
						"constructionGroups",
						groupIndex,
						"workflowId",
					],
					message: "A construction group belongs to its slice workflow.",
				});
			}
			if (groupIds.has(group.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "constructionGroups", groupIndex, "id"],
					message: "Construction group ids must be unique.",
				});
			}
			groupIds.add(group.id);
		});
	});
	if (roots !== 1) {
		ctx.addIssue({
			code: "custom",
			path: ["slices"],
			message: "A build plan requires exactly one materialization root.",
		});
	}
	plan.slices.forEach((slice, sliceIndex) => {
		slice.prerequisiteSliceIds.forEach((id, index) => {
			if (!sliceIds.has(id))
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "prerequisiteSliceIds", index],
					message: "The prerequisite slice does not exist.",
				});
			if (id === slice.id)
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "prerequisiteSliceIds", index],
					message: "A slice cannot depend on itself.",
				});
		});
	});
	const byId = new Map<string, BuildSlice>(
		plan.slices.map((slice) => [slice.id, slice]),
	);
	for (const [sliceIndex, slice] of plan.slices.entries()) {
		const visiting = new Set<string>([slice.id]);
		const cycle = (id: string): boolean => {
			if (visiting.has(id)) return true;
			visiting.add(id);
			const found = (byId.get(id)?.prerequisiteSliceIds ?? []).some(cycle);
			visiting.delete(id);
			return found;
		};
		if (slice.prerequisiteSliceIds.some(cycle))
			ctx.addIssue({
				code: "custom",
				path: ["slices", sliceIndex, "prerequisiteSliceIds"],
				message: "Slice prerequisites must be acyclic.",
			});
	}
}

export const buildPlanSchema = buildPlanBaseSchema.superRefine(validatePlan);

/** Contract-bound persisted-read proof. */
export function buildPlanSchemaFor(contract: AppDesignContract) {
	return buildPlanSchema.superRefine((plan, ctx) => {
		const workflowIds = new Set(
			contract.workflows.map((workflow) => workflow.id),
		);
		const constructibleElementIds = new Set<string>([
			...contract.actors.map((value) => value.id),
			...contract.records.flatMap((record) => [
				record.id,
				...record.properties.map((property) => property.id),
			]),
			...contract.workflows.map((value) => value.id),
			...contract.lists.map((value) => value.id),
			...contract.access.map((value) => value.id),
			...contract.navigation.map((value) => value.id),
		]);
		const knownElementIds = new Set<string>([
			...constructibleElementIds,
			...contract.externalRequirements.map((value) => value.id),
		]);
		const assigned = new Map<string, string>();
		plan.slices.forEach((slice, sliceIndex) => {
			if (!workflowIds.has(slice.workflowId))
				ctx.addIssue({
					code: "custom",
					path: ["slices", sliceIndex, "workflowId"],
					message: "This slice workflow is absent from the accepted design.",
				});
			slice.constructionGroups.forEach((group, groupIndex) => {
				group.elements.forEach((element, elementIndex) => {
					if (!knownElementIds.has(element.id))
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"id",
							],
							message:
								"This construction element is absent from the accepted design.",
						});
					const owner = assigned.get(element.id);
					if (owner !== undefined && owner !== group.id)
						ctx.addIssue({
							code: "custom",
							path: [
								"slices",
								sliceIndex,
								"constructionGroups",
								groupIndex,
								"elements",
								elementIndex,
								"id",
							],
							message:
								"A semantic element may belong to only one construction group.",
						});
					assigned.set(element.id, group.id);
				});
			});
		});
		for (const id of constructibleElementIds) {
			if (!assigned.has(id))
				ctx.addIssue({
					code: "custom",
					path: ["slices"],
					message: `Design element ${id} is not assigned to a construction group.`,
				});
		}
	});
}

function stableId(
	revisionDigest: string,
	kind: string,
	id: string,
): z.infer<typeof designIdSchema> {
	return designIdSchema.parse(
		deterministicDesignId(`build-plan-v1:${revisionDigest}:${kind}:${id}`),
	);
}

function workflowOrder(contract: AppDesignContract): string[] {
	const order = new Map(
		contract.workflows.map((workflow, index) => [workflow.id, index]),
	);
	const remaining = new Set(contract.workflows.map((workflow) => workflow.id));
	const emitted: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((id) =>
				(
					contract.workflows.find((workflow) => workflow.id === id)
						?.prerequisiteWorkflowIds ?? []
				).every((dependency) => !remaining.has(dependency)),
			)
			.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
		if (ready.length === 0)
			throw new Error("Accepted design has cyclic workflow prerequisites.");
		for (const id of ready) {
			remaining.delete(id);
			emitted.push(id);
		}
	}
	return emitted;
}

/** Derive the complete BuildPlan from one exact accepted revision. */
export function deriveBuildPlan(args: {
	readonly contract: AppDesignContract;
	readonly revision: { readonly id: string; readonly digest: string };
	readonly planId?: string;
}): BuildPlan {
	const { contract, revision } = args;
	const constructionIssues = designConstructionIssues(contract);
	if (constructionIssues.length > 0) {
		throw new Error(
			`Accepted design is not constructible: ${constructionIssues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	const orderedWorkflowIds = workflowOrder(contract);
	const rank = new Map(orderedWorkflowIds.map((id, index) => [id, index]));
	const workflowById = new Map<string, AppDesignContract["workflows"][number]>(
		contract.workflows.map((workflow) => [workflow.id, workflow]),
	);
	const initial = contract.charter.initialWorkflowId;
	const earliest = (ids: readonly string[]): string =>
		[...ids].sort(
			(a, b) =>
				(rank.get(a) ?? Number.MAX_SAFE_INTEGER) -
				(rank.get(b) ?? Number.MAX_SAFE_INTEGER),
		)[0] ?? initial;

	const ownerByElement = new Map<string, string>();
	for (const workflow of contract.workflows)
		ownerByElement.set(workflow.id, workflow.id);
	for (const actor of contract.actors) {
		ownerByElement.set(
			actor.id,
			earliest(
				contract.workflows
					.filter((workflow) => workflow.actorIds.includes(actor.id))
					.map((workflow) => workflow.id),
			),
		);
	}
	for (const record of contract.records) {
		const references = contract.workflows.filter(
			(workflow) =>
				workflow.contextRecordId === record.id ||
				workflow.recordEffects.some(
					(effect) =>
						effect.recordId === record.id ||
						effect.sourceRecordId === record.id,
				) ||
				workflow.readback.some((readback) => readback.recordId === record.id),
		);
		const creators = references.filter((workflow) =>
			workflow.recordEffects.some(
				(effect) => effect.recordId === record.id && effect.kind === "create",
			),
		);
		ownerByElement.set(
			record.id,
			earliest(
				(creators.length > 0 ? creators : references).map(
					(workflow) => workflow.id,
				),
			),
		);
		for (const property of record.properties) {
			const writers = contract.workflows.filter(
				(workflow) =>
					workflow.inputs.some((input) => input.propertyId === property.id) ||
					workflow.recordEffects.some((effect) =>
						effect.writes.some((write) => write.propertyId === property.id),
					),
			);
			ownerByElement.set(
				property.id,
				earliest(writers.map((workflow) => workflow.id)),
			);
		}
	}
	for (const list of contract.lists) {
		const related =
			list.selectionWorkflowId !== undefined
				? [list.selectionWorkflowId]
				: contract.workflows
						.filter(
							(workflow) =>
								workflow.contextRecordId === list.recordId ||
								workflow.recordEffects.some(
									(effect) => effect.recordId === list.recordId,
								),
						)
						.map((workflow) => workflow.id);
		ownerByElement.set(list.id, earliest(related));
	}
	for (const nav of contract.navigation)
		ownerByElement.set(
			nav.id,
			earliest([
				...nav.workflowIds,
				...nav.listIds.map((id) => ownerByElement.get(id) ?? initial),
			]),
		);
	for (const policy of contract.access)
		ownerByElement.set(
			policy.id,
			earliest(
				policy.targets.map((target) =>
					target.kind === "workflow"
						? target.id
						: (ownerByElement.get(target.id) ?? initial),
				),
			),
		);
	const refsFor = (
		workflowId: string,
		kinds: DesignElementRef["kind"][],
	): DesignElementRef[] => {
		const refs: DesignElementRef[] = [];
		const push = (kind: DesignElementRef["kind"], id: string): void => {
			if (ownerByElement.get(id) === workflowId && kinds.includes(kind))
				refs.push({ kind, id: designIdSchema.parse(id) });
		};
		contract.actors.forEach((value) => {
			push("actor", value.id);
		});
		contract.records.forEach((record) => {
			push("record", record.id);
			record.properties.forEach((property) => {
				push("property", property.id);
			});
		});
		contract.workflows.forEach((value) => {
			push("workflow", value.id);
		});
		contract.lists.forEach((value) => {
			push("list", value.id);
		});
		contract.access.forEach((value) => {
			push("access", value.id);
		});
		contract.navigation.forEach((value) => {
			push("navigation", value.id);
		});
		return refs;
	};
	const groupsFor = (workflowId: string): ConstructionGroup[] => {
		const specs: Array<{
			key: string;
			name: string;
			kind: ConstructionGroup["kind"];
			kinds: DesignElementRef["kind"][];
			areas: BlueprintArea[];
		}> = [
			{
				key: "foundation",
				name: "Data and people",
				kind: "foundation",
				kinds: ["actor", "record", "property"],
				areas: ["app", "case-catalog", "users"],
			},
			{
				key: "workflow",
				name: "Workflow",
				kind: "workflow",
				kinds: ["workflow"],
				areas: ["forms", "case-operations"],
			},
			{
				key: "queues",
				name: "Lists and search",
				kind: "work-queue",
				kinds: ["list"],
				areas: ["case-list"],
			},
			{
				key: "access",
				name: "Access and navigation",
				kind: "access-navigation",
				kinds: ["access", "navigation"],
				areas: ["navigation", "users", "organization-shape"],
			},
		];
		return specs.flatMap((spec) => {
			const elements = refsFor(workflowId, spec.kinds);
			return elements.length === 0
				? []
				: [
						{
							id: stableId(revision.digest, `group:${spec.key}`, workflowId),
							workflowId: designIdSchema.parse(workflowId),
							name: spec.name,
							kind: spec.kind,
							elements,
							blueprintAreas: spec.areas,
						},
					];
		});
	};

	const externalActions: ExternalAction[] = contract.externalRequirements.map(
		(requirement) => ({
			id: stableId(revision.digest, "external-action", requirement.id),
			requirementId: requirement.id,
			kind: requirement.kind,
			timing: requirement.blocksConstruction
				? requirement.timing === "before-construction"
					? "before-materialization"
					: "before-slice"
				: requirement.timing === "before-deployment"
					? "manual-setup"
					: "after-slice",
			requiredFor: requirement.blocksConstruction
				? "construction"
				: requirement.timing === "before-deployment"
					? "deployment"
					: "runtime",
			description: requirement.description,
			completionEvidence: requirement.blocksConstruction
				? "A durable completion receipt is required before the affected slice opens."
				: "The generated setup guidance records this readiness item for the person deploying or running the app.",
		}),
	);
	const actionByRequirement = new Map(
		externalActions.map((action) => [action.requirementId, action.id]),
	);
	const sliceIdByWorkflow = new Map(
		orderedWorkflowIds.map((id) => [
			id,
			stableId(revision.digest, "slice", id),
		]),
	);
	const slices: BuildSlice[] = orderedWorkflowIds.map((workflowId) => {
		const workflow = workflowById.get(workflowId);
		if (workflow === undefined)
			throw new Error(`Missing workflow ${workflowId}.`);
		const crossRecord =
			new Set(workflow.recordEffects.map((effect) => effect.recordId)).size >
				1 ||
			workflow.recordEffects.some(
				(effect) => effect.kind === "link" || effect.kind === "reassign",
			);
		return {
			id: sliceIdByWorkflow.get(workflowId) as z.infer<typeof designIdSchema>,
			workflowId: workflow.id,
			name: workflow.name,
			goal: workflow.goal,
			prerequisiteSliceIds: workflow.prerequisiteWorkflowIds.map(
				(id) => sliceIdByWorkflow.get(id) as z.infer<typeof designIdSchema>,
			),
			constructionGroups: groupsFor(workflowId),
			externalActionIds: workflow.externalRequirementIds
				.map((id) => actionByRequirement.get(id))
				.filter((id): id is z.infer<typeof designIdSchema> => id !== undefined),
			risk: crossRecord
				? "cross-record"
				: workflow.externalRequirementIds.length > 0
					? "external-effect"
					: "ordinary",
			role: workflowId === initial ? "materialization-root" : "ordinary",
		};
	});
	return buildPlanSchemaFor(contract).parse({
		schemaVersion: 1,
		designRevisionId: revision.id,
		designRevisionDigest: revision.digest,
		id: args.planId ?? crypto.randomUUID(),
		slices,
		externalActions,
	});
}

/** Environment-dependent admission policy. The v1 schema retains producer-
 * bound blocking-action timings, but this deployment may not persist one
 * until its durable receipt producer is registered. */
export function newPlanAdmissionMessages(
	plan: Pick<BuildPlan, "externalActions">,
): string[] {
	return plan.externalActions.flatMap((action) =>
		action.timing === "before-materialization" ||
		action.timing === "before-slice"
			? [
					`External action ${action.id} uses ${action.timing}, but no registered completion producer can issue its durable receipt. Use manual-setup or after-slice for a newly admitted plan.`,
				]
			: [],
	);
}
