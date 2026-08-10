/**
 * The build-slice plan — how an accepted Design Contract becomes ordered,
 * dependency-closed Build Slices, with every external effect named as a
 * typed external action rather than smuggled in as a Blueprint mutation.
 *
 * A slice is organized around actor tasks and observable outcomes, never
 * modules. Exactly one slice is the materialization root: the smallest
 * task-complete, dependency-closed, USEFUL first app — not the smallest
 * mutation count. Ownership is exact: every implementable intent of the
 * accepted contract has exactly one owning slice, and contribution never
 * double-counts completion.
 *
 * Two schema layers, like `review.ts`: the structural
 * `buildPlanSchema` carries every self-contained rule (unique ids, acyclic
 * DAG, one root, ownership coherence, root-closure external-action timing)
 * and is what persisted reads parse; `buildPlanSchemaFor(contract)` binds
 * the cross-artifact rules (intent existence and exact ownership coverage,
 * scenario coverage, parent-selection reachability) into the parse.
 *
 * Identity note: the planner model mints slice/action DesignIds; the SERVER
 * stamps `id`, `designRevisionId`, and `designRevisionDigest` when it
 * composes the persisted payload — a model never chooses server identity.
 */

import { z } from "zod";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const externalActionSchema = z
	.object({
		id: designIdSchema,
		kind: z.enum([
			"media-upload",
			"place-write",
			"lookup-write",
			"hq-setup",
			"deployment",
			"worker-provisioning",
			"manual",
		]),
		timing: z.enum([
			"before-materialization",
			"before-slice",
			"after-slice",
			"manual-setup",
		]),
		requiredFor: z.enum(["construction", "runtime", "deployment", "optional"]),
		description: z.string().min(1),
		idempotencyOwner: z.enum(["nova", "user", "external-system"]),
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

/**
 * A Build Slice is admitted only after the planner has made the lowering
 * choices the compiler needs. These are design-to-Nova decisions, not a
 * second Blueprint document: every row points back to a DesignId and names a
 * closed strategy choice while UUIDs, names, expressions, and mutations stay
 * the executor's job.
 */
export const constructionLoweringTargetSchema = z.enum([
	"case-type",
	"case-property",
	"form-logic",
	"task-form",
	"registration-create",
	"case-operation",
	"case-list",
	"case-search",
	"access-control",
	"navigation",
]);
export type ConstructionLoweringTarget = z.infer<
	typeof constructionLoweringTargetSchema
>;

export const constructionStrategySchema = z
	.object({
		semanticGroups: z
			.array(
				z
					.object({
						name: z.string().min(1),
						kind: z.enum([
							"foundation",
							"capture",
							"workflow",
							"work-queue",
							"access-navigation",
						]),
						intentIds: z.array(designIdSchema).min(1),
						blueprintAreas: z.array(blueprintAreaSchema).min(1),
					})
					.strict(),
			)
			.min(1),
		lowerings: z
			.array(
				z
					.object({
						intentId: designIdSchema,
						target: constructionLoweringTargetSchema,
					})
					.strict(),
			)
			.min(1),
		tasks: z.array(
			z
				.object({
					taskId: designIdSchema,
					mode: z.enum(["registration", "case-action", "survey"]),
					contextRecordId: designIdSchema.optional(),
					transitionIds: z.array(designIdSchema),
					primaryCreateTransitionId: designIdSchema.optional(),
				})
				.strict(),
		),
		facts: z.array(
			z
				.object({
					factId: designIdSchema,
					storage: z.enum(["case-property", "form-only"]),
					writer: z.enum([
						"task-input",
						"calculation",
						"session",
						"lookup",
						"external",
						"constant",
					]),
					unanswered: z.enum(["preserve", "clear"]),
				})
				.strict(),
		),
		readModels: z.array(
			z
				.object({
					readModelId: designIdSchema,
					mode: z.enum(["case-list", "case-search"]),
					rolePartition: z.enum([
						"shared",
						"actor-gated",
						"separate-navigation",
					]),
					searchFilterFactIds: z.array(designIdSchema),
				})
				.strict(),
		),
		access: z.array(
			z
				.object({
					accessPolicyId: designIdSchema,
					layers: z
						.array(
							z.enum([
								"navigation-visibility",
								"case-context",
								"location-scope",
								"search-filter",
								"manual-setup",
							]),
						)
						.min(1),
				})
				.strict(),
		),
		navigation: z.array(
			z
				.object({
					navigationId: designIdSchema,
					mode: z.enum(["module", "menu"]),
				})
				.strict(),
		),
		externalSetupActionIds: z.array(designIdSchema),
	})
	.strict();
export type ConstructionStrategy = z.infer<typeof constructionStrategySchema>;

export const buildSliceSchema = z
	.object({
		id: designIdSchema,
		name: z.string().min(1),
		goal: z.string().min(1),
		intentIds: z.array(designIdSchema).min(1),
		ownedIntentIds: z.array(designIdSchema).min(1),
		prerequisiteSliceIds: z.array(designIdSchema),
		acceptanceScenarioIds: z.array(designIdSchema),
		risk: buildSliceRiskSchema,
		role: z.enum(["materialization-root", "ordinary", "exclusive"]),
		constructionStrategy: constructionStrategySchema,
		externalActionIds: z.array(designIdSchema),
	})
	.strict();
export type BuildSlice = z.infer<typeof buildSliceSchema>;

/** Above this, the bounded executor cannot reliably lower one slice before its
 * hard wall-clock ceiling. */
export const MAX_OWNED_INTENTS_PER_SLICE = 30;
export const MAX_CONSTRUCTION_GROUPS_PER_SLICE = 8;
export const MAX_INTENTS_PER_CONSTRUCTION_GROUP = 12;

export const intentOwnershipEntrySchema = z
	.object({
		intentId: designIdSchema,
		owningSliceId: designIdSchema,
		contributingSliceIds: z.array(designIdSchema),
	})
	.strict();
export type IntentOwnershipEntry = z.infer<typeof intentOwnershipEntrySchema>;

const buildPlanBaseSchema = z
	.object({
		schemaVersion: z.literal(1),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: sha256HexSchema,
		id: z.string().uuid(),
		slices: z.array(buildSliceSchema).min(1),
		externalActions: z.array(externalActionSchema),
		intentOwnership: z.array(intentOwnershipEntrySchema),
	})
	.strict();
export type BuildPlan = z.infer<typeof buildPlanBaseSchema>;

/** The structural authority — every self-contained plan rule, used by
 *  persisted reads and composed by the contract-bound factory. */
export const buildPlanSchema = buildPlanBaseSchema.superRefine(
	validateSlicePlanStructure,
);

/**
 * The PLANNER MODEL's output shape: slices, external actions, and intent
 * ownership only. `schemaVersion`, the plan id, and the revision identity
 * are server-stamped when the pipeline composes the persisted plan — a
 * model never chooses server identity (§22.8). The composed plan then
 * parses through `buildPlanSchemaFor(contract)`, which is where every
 * structural and cross-contract rule runs.
 */
export const buildPlanDraftSchema = z
	.object({
		slices: z.array(buildSliceSchema).min(1),
		externalActions: z.array(externalActionSchema),
		intentOwnership: z.array(intentOwnershipEntrySchema),
	})
	.strict();
export type BuildPlanDraft = z.infer<typeof buildPlanDraftSchema>;

/** Top-level retry patch for the immediately preceding rejected plan. */
export const buildPlanDraftRepairSchema = buildPlanDraftSchema
	.partial()
	.refine((repair) => Object.keys(repair).length > 0, {
		message: "A plan repair must replace at least one top-level collection.",
	});
export type BuildPlanDraftRepair = z.infer<typeof buildPlanDraftRepairSchema>;

/** The intents a plan must give exactly one owner: the implementable
 *  intents of the accepted contract. Actors, decisions, assumptions, open
 *  questions, scenarios, and claims are context, not implementable units. */
export function implementableIntentIds(
	contract: AppDesignContract,
): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const record of contract.records) ids.add(record.id);
	for (const fact of contract.facts) ids.add(fact.id);
	for (const rule of contract.rules) ids.add(rule.id);
	for (const task of contract.tasks) ids.add(task.id);
	for (const transition of contract.transitions) ids.add(transition.id);
	for (const model of contract.readModels) ids.add(model.id);
	for (const policy of contract.accessPolicies) ids.add(policy.id);
	for (const nav of contract.navigation) ids.add(nav.id);
	return ids;
}

export function validateSlicePlanStructure(
	plan: BuildPlan,
	ctx: z.RefinementCtx,
): void {
	const issue = (path: Array<string | number>, message: string) =>
		ctx.addIssue({ code: "custom", path, message });

	/* Unique plan-local identities. */
	const sliceById = new Map<string, BuildSlice>();
	plan.slices.forEach((slice, i) => {
		if (sliceById.has(slice.id)) {
			issue(
				["slices", i, "id"],
				"Two slices share one id — slice ids are identity, mint a fresh one.",
			);
			return;
		}
		sliceById.set(slice.id, slice);
	});
	const actionById = new Map<string, ExternalAction>();
	plan.externalActions.forEach((action, i) => {
		if (actionById.has(action.id) || sliceById.has(action.id)) {
			issue(
				["externalActions", i, "id"],
				"An external action's id collides with another plan object — plan ids share one namespace.",
			);
			return;
		}
		actionById.set(action.id, action);
	});

	/* References resolve; owned ⊆ named intents. */
	plan.slices.forEach((slice, i) => {
		slice.prerequisiteSliceIds.forEach((id, j) => {
			if (!sliceById.has(id)) {
				issue(
					["slices", i, "prerequisiteSliceIds", j],
					`The slice "${slice.name}" names a prerequisite that is not a slice in this plan.`,
				);
			} else if (id === slice.id) {
				issue(
					["slices", i, "prerequisiteSliceIds", j],
					`The slice "${slice.name}" lists itself as a prerequisite.`,
				);
			}
		});
		slice.externalActionIds.forEach((id, j) => {
			if (!actionById.has(id)) {
				issue(
					["slices", i, "externalActionIds", j],
					`The slice "${slice.name}" names an external action that is not in this plan.`,
				);
			}
		});
		const named = new Set(slice.intentIds);
		slice.ownedIntentIds.forEach((id, j) => {
			if (!named.has(id)) {
				issue(
					["slices", i, "ownedIntentIds", j],
					`The slice "${slice.name}" owns an intent it does not list in its intentIds — an owned intent is always one of the slice's intents.`,
				);
			}
		});

		const exactlyOnce = (
			ids: readonly string[],
			path: Array<string | number>,
			label: string,
		): void => {
			const seen = new Set<string>();
			for (const id of ids) {
				if (seen.has(id)) {
					issue(path, `${label} names one intent more than once.`);
					break;
				}
				seen.add(id);
			}
			const owned = new Set<string>(slice.ownedIntentIds);
			if (seen.size !== owned.size || [...seen].some((id) => !owned.has(id))) {
				const missing = [...owned].filter((id) => !seen.has(id));
				const dependencyOnly = [...seen].filter((id) => !owned.has(id));
				issue(
					path,
					`${label} must cover every owned intent exactly once and may not include dependency-only intents. Missing owned ids: ${missing.length > 0 ? missing.join(", ") : "none"}. Remove dependency-only ids: ${dependencyOnly.length > 0 ? dependencyOnly.join(", ") : "none"}.`,
				);
			}
		};
		exactlyOnce(
			slice.constructionStrategy.semanticGroups.flatMap(
				(group) => group.intentIds,
			),
			["slices", i, "constructionStrategy", "semanticGroups"],
			"The construction strategy's semantic groups",
		);
		exactlyOnce(
			slice.constructionStrategy.lowerings.map((entry) => entry.intentId),
			["slices", i, "constructionStrategy", "lowerings"],
			"The construction strategy's lowering table",
		);
		if (slice.ownedIntentIds.length > MAX_OWNED_INTENTS_PER_SLICE) {
			issue(
				["slices", i, "ownedIntentIds"],
				`The slice "${slice.name}" owns ${slice.ownedIntentIds.length} intents. A slice may own at most ${MAX_OWNED_INTENTS_PER_SLICE}; split it around smaller task-complete outcomes. For the materialization root, keep only the minimal registration path and its first usable registry, leaving downstream status rules and work queues to later slices.`,
			);
		}
		if (
			slice.constructionStrategy.semanticGroups.length >
			MAX_CONSTRUCTION_GROUPS_PER_SLICE
		) {
			issue(
				["slices", i, "constructionStrategy", "semanticGroups"],
				`The slice "${slice.name}" has ${slice.constructionStrategy.semanticGroups.length} construction groups. A slice may have at most ${MAX_CONSTRUCTION_GROUPS_PER_SLICE}; split it at a task-complete boundary before execution.`,
			);
		}
		for (const [
			groupIndex,
			group,
		] of slice.constructionStrategy.semanticGroups.entries()) {
			if (group.intentIds.length <= MAX_INTENTS_PER_CONSTRUCTION_GROUP)
				continue;
			issue(
				[
					"slices",
					i,
					"constructionStrategy",
					"semanticGroups",
					groupIndex,
					"intentIds",
				],
				`The construction group "${group.name}" in slice "${slice.name}" contains ${group.intentIds.length} intents. A group may contain at most ${MAX_INTENTS_PER_CONSTRUCTION_GROUP}; separate its independently constructible record, workflow, queue, or access work.`,
			);
		}

		for (const [collection, ids] of [
			["tasks", slice.constructionStrategy.tasks.map((entry) => entry.taskId)],
			["facts", slice.constructionStrategy.facts.map((entry) => entry.factId)],
			[
				"readModels",
				slice.constructionStrategy.readModels.map((entry) => entry.readModelId),
			],
			[
				"access",
				slice.constructionStrategy.access.map((entry) => entry.accessPolicyId),
			],
			[
				"navigation",
				slice.constructionStrategy.navigation.map(
					(entry) => entry.navigationId,
				),
			],
		] as const) {
			if (new Set(ids).size !== ids.length) {
				issue(
					["slices", i, "constructionStrategy", collection],
					`The construction strategy has two ${collection} rows for one intent.`,
				);
			}
		}

		const manualActionIds = slice.externalActionIds.filter(
			(id) => actionById.get(id)?.timing === "manual-setup",
		);
		const declaredSetup = slice.constructionStrategy.externalSetupActionIds;
		if (
			new Set(declaredSetup).size !== declaredSetup.length ||
			new Set(declaredSetup).size !== new Set(manualActionIds).size ||
			declaredSetup.some((id) => !manualActionIds.includes(id))
		) {
			issue(
				["slices", i, "constructionStrategy", "externalSetupActionIds"],
				"The construction strategy must name exactly this slice's manual-setup external actions, once each.",
			);
		}
	});

	/* Acyclic prerequisite DAG. */
	const visiting = new Set<string>();
	const done = new Set<string>();
	const cyclic = new Set<string>();
	const visit = (id: string): boolean => {
		if (done.has(id)) return cyclic.has(id);
		if (visiting.has(id)) return true;
		visiting.add(id);
		let inCycle = false;
		const slice = sliceById.get(id);
		for (const prereq of slice?.prerequisiteSliceIds ?? []) {
			if (sliceById.has(prereq) && visit(prereq)) inCycle = true;
		}
		visiting.delete(id);
		done.add(id);
		if (inCycle) cyclic.add(id);
		return inCycle;
	};
	plan.slices.forEach((slice, i) => {
		if (visiting.size === 0 && visit(slice.id) && cyclic.has(slice.id)) {
			issue(
				["slices", i, "prerequisiteSliceIds"],
				`The slice "${slice.name}" sits in a prerequisite cycle — the dependency graph must be a DAG.`,
			);
		}
	});

	/* Exactly one materialization root. */
	const roots = plan.slices.filter((s) => s.role === "materialization-root");
	if (roots.length !== 1) {
		issue(
			["slices"],
			roots.length === 0
				? "No slice is the materialization root. Exactly one slice must be the first, dependency-closed, export-ready app."
				: "More than one slice claims the materialization root. Exactly one slice materializes the app; later slices are ordinary canonical commits.",
		);
	}

	/* Root-closure rules: nothing post-materialization inside it, and no
	 * data migration before an app exists. */
	const root = roots[0];
	if (root !== undefined) {
		if (root.prerequisiteSliceIds.length > 0) {
			const rootIndex = plan.slices.findIndex((slice) => slice.id === root.id);
			issue(
				["slices", rootIndex, "prerequisiteSliceIds"],
				"The materialization root cannot name prerequisite slices. Everything needed for the first export-ready app must be owned and lowered atomically by the root itself.",
			);
		}
		const closure = new Set<string>();
		const queue = [root.id];
		while (queue.length > 0) {
			const id = queue.pop() as string;
			if (closure.has(id)) continue;
			closure.add(id);
			for (const prereq of sliceById.get(id)?.prerequisiteSliceIds ?? []) {
				if (sliceById.has(prereq)) queue.push(prereq);
			}
		}
		plan.slices.forEach((slice, i) => {
			if (!closure.has(slice.id)) return;
			if (slice.risk === "data-migration") {
				issue(
					["slices", i, "risk"],
					`The slice "${slice.name}" is a data migration inside the materialization root's closure — before the app exists there is no data to migrate.`,
				);
			}
			slice.externalActionIds.forEach((actionId, j) => {
				const action = actionById.get(actionId);
				if (!action) return;
				if (
					action.timing !== "before-materialization" &&
					action.timing !== "manual-setup"
				) {
					issue(
						["slices", i, "externalActionIds", j],
						`The slice "${slice.name}" is in the materialization root's closure but depends on an external action timed "${action.timing}" — everything the first app needs must be satisfied before materialization or named as manual setup.`,
					);
				}
			});
		});
	}

	/* Ownership coherence between the two representations. */
	const ownerBySliceList = new Map<string, string>();
	plan.slices.forEach((slice, i) => {
		for (const intentId of slice.ownedIntentIds) {
			const other = ownerBySliceList.get(intentId);
			if (other !== undefined && other !== slice.id) {
				issue(
					["slices", i, "ownedIntentIds"],
					`Two slices both claim to own the same intent — ownership is exact, one owner per intent.`,
				);
			}
			ownerBySliceList.set(intentId, slice.id);
		}
	});
	const ownershipByIntent = new Map<string, IntentOwnershipEntry>();
	plan.intentOwnership.forEach((entry, i) => {
		if (ownershipByIntent.has(entry.intentId)) {
			issue(
				["intentOwnership", i, "intentId"],
				"This intent already has an ownership row — one row per intent.",
			);
			return;
		}
		ownershipByIntent.set(entry.intentId, entry);
		if (!sliceById.has(entry.owningSliceId)) {
			issue(
				["intentOwnership", i, "owningSliceId"],
				"The owning slice does not exist in this plan.",
			);
		}
		entry.contributingSliceIds.forEach((id, j) => {
			if (!sliceById.has(id)) {
				issue(
					["intentOwnership", i, "contributingSliceIds", j],
					"A contributing slice does not exist in this plan.",
				);
			} else if (id === entry.owningSliceId) {
				issue(
					["intentOwnership", i, "contributingSliceIds", j],
					"The owning slice cannot also be listed as a contributor — contribution never double-counts ownership.",
				);
			}
		});
		const listedOwner = ownerBySliceList.get(entry.intentId);
		if (listedOwner !== undefined && listedOwner !== entry.owningSliceId) {
			issue(
				["intentOwnership", i, "owningSliceId"],
				"The ownership row and the slices' ownedIntentIds disagree about who owns this intent.",
			);
		}
	});
	for (const [intentId, sliceId] of ownerBySliceList) {
		const entry = ownershipByIntent.get(intentId);
		if (entry === undefined) {
			const sliceIndex = plan.slices.findIndex((s) => s.id === sliceId);
			issue(
				["slices", sliceIndex, "ownedIntentIds"],
				"An owned intent has no matching intentOwnership row — the two representations must agree.",
			);
		}
	}
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

/**
 * The parse-time planner schema, bound to the accepted contract:
 *  - every slice intent resolves to an implementable intent of the
 *    contract, and ownership covers EXACTLY that set (each intent one
 *    owner, nothing extra, nothing missing);
 *  - every slice scenario resolves, and every contract scenario belongs to
 *    at least one slice;
 *  - a slice owning a child-creating task can reach a read model over the
 *    parent record in itself or its prerequisite closure (the worker must
 *    select the parent before creating the child).
 */
export function buildPlanSchemaFor(contract: AppDesignContract) {
	return buildPlanSchema.superRefine((plan, ctx) =>
		validateSlicePlanAgainstContract(plan, contract, ctx),
	);
}

export function validateSlicePlanAgainstContract(
	plan: BuildPlan,
	contract: AppDesignContract,
	ctx: z.RefinementCtx,
): void {
	const issue = (path: Array<string | number>, message: string) =>
		ctx.addIssue({ code: "custom", path, message });
	const implementable = implementableIntentIds(contract);
	const scenarioIds = new Set(contract.acceptanceScenarios.map((s) => s.id));
	const sliceById = new Map<string, BuildSlice>(
		plan.slices.map((slice) => [slice.id, slice]),
	);
	const recordById: ReadonlyMap<string, (typeof contract.records)[number]> =
		new Map(contract.records.map((entry) => [entry.id, entry]));
	const factById: ReadonlyMap<string, (typeof contract.facts)[number]> =
		new Map(contract.facts.map((entry) => [entry.id, entry]));
	const ruleById: ReadonlyMap<string, (typeof contract.rules)[number]> =
		new Map(contract.rules.map((entry) => [entry.id, entry]));
	const taskById: ReadonlyMap<string, (typeof contract.tasks)[number]> =
		new Map(contract.tasks.map((entry) => [entry.id, entry]));
	const transitionById: ReadonlyMap<
		string,
		(typeof contract.transitions)[number]
	> = new Map(contract.transitions.map((entry) => [entry.id, entry]));
	const readModelById: ReadonlyMap<
		string,
		(typeof contract.readModels)[number]
	> = new Map(contract.readModels.map((entry) => [entry.id, entry]));
	const accessById: ReadonlyMap<
		string,
		(typeof contract.accessPolicies)[number]
	> = new Map(contract.accessPolicies.map((entry) => [entry.id, entry]));
	const navigationById: ReadonlyMap<
		string,
		(typeof contract.navigation)[number]
	> = new Map(contract.navigation.map((entry) => [entry.id, entry]));
	const expectedTarget = (
		id: string,
		registrationCreateIds: ReadonlySet<string>,
	): ConstructionLoweringTarget | null => {
		if (recordById.has(id)) return "case-type";
		if (factById.has(id)) return "case-property";
		if (ruleById.has(id)) return "form-logic";
		if (taskById.has(id)) return "task-form";
		if (transitionById.has(id)) {
			return registrationCreateIds.has(id)
				? "registration-create"
				: "case-operation";
		}
		/* A read model's accepted facts describe what can be searched, not
		 * whether the app should use a synced list or live case search. The
		 * construction strategy makes that lowering explicit below. */
		if (readModelById.has(id)) return null;
		if (accessById.has(id)) return "access-control";
		if (navigationById.has(id)) return "navigation";
		return null;
	};
	const sameIds = (
		left: readonly string[],
		right: readonly string[],
	): boolean =>
		new Set(left).size === new Set(right).size &&
		left.every((id) => right.includes(id));
	const expectedOwnedIds = <T>(
		slice: BuildSlice,
		index: ReadonlyMap<string, T>,
	): string[] => slice.ownedIntentIds.filter((id) => index.has(id));

	plan.slices.forEach((slice, i) => {
		const strategy = slice.constructionStrategy;
		const registrationCreateIds = new Set(
			strategy.tasks.flatMap((binding) => {
				if (!slice.ownedIntentIds.includes(binding.taskId)) return [];
				const task = taskById.get(binding.taskId);
				if (task?.contextRecordId !== undefined) return [];
				const contractCreateIds =
					task?.transitionIds.filter(
						(id) => transitionById.get(id)?.transitionKind === "create",
					) ?? [];
				/* A single create is unambiguously the registration action even
				 * when the planner omitted or mistyped the explicit selection. Use
				 * it here so one validation pass reports both plan defects. */
				const selected =
					contractCreateIds.length === 1
						? contractCreateIds[0]
						: binding.primaryCreateTransitionId;
				return selected === undefined ? [] : [selected];
			}),
		);
		slice.intentIds.forEach((id, j) => {
			if (!implementable.has(id)) {
				issue(
					["slices", i, "intentIds", j],
					`The slice "${slice.name}" names an intent that is not an implementable intent of the accepted contract (records, facts, rules, tasks, transitions, read models, access policies, navigation).`,
				);
			}
		});
		slice.acceptanceScenarioIds.forEach((id, j) => {
			if (!scenarioIds.has(id)) {
				issue(
					["slices", i, "acceptanceScenarioIds", j],
					`The slice "${slice.name}" claims an acceptance scenario the contract does not contain.`,
				);
			}
		});

		const ownedIntentIds = new Set(slice.ownedIntentIds);
		for (const [
			j,
			lowering,
		] of slice.constructionStrategy.lowerings.entries()) {
			if (!ownedIntentIds.has(lowering.intentId)) continue;
			const expected = expectedTarget(lowering.intentId, registrationCreateIds);
			if (expected !== null && lowering.target !== expected) {
				issue(
					["slices", i, "constructionStrategy", "lowerings", j, "target"],
					`Intent ${lowering.intentId} lowers to ${expected}, not ${lowering.target}.`,
				);
			}
		}

		const requireExactRows = (
			actual: readonly string[],
			expected: readonly string[],
			collection: "tasks" | "facts" | "readModels" | "access" | "navigation",
		): void => {
			if (!sameIds(actual, expected)) {
				const actualIds = new Set(actual);
				const expectedIds = new Set(expected);
				const missing = expected.filter((id) => !actualIds.has(id));
				const dependencyOnly = actual.filter((id) => !expectedIds.has(id));
				issue(
					["slices", i, "constructionStrategy", collection],
					`The ${collection} strategy rows must name exactly the owned ${collection} intents. Missing owned ids: ${missing.length > 0 ? missing.join(", ") : "none"}. Remove dependency-only ids: ${dependencyOnly.length > 0 ? dependencyOnly.join(", ") : "none"}.`,
				);
			}
		};
		requireExactRows(
			strategy.tasks.map((entry) => entry.taskId),
			expectedOwnedIds(slice, taskById),
			"tasks",
		);
		requireExactRows(
			strategy.facts.map((entry) => entry.factId),
			expectedOwnedIds(slice, factById),
			"facts",
		);
		requireExactRows(
			strategy.readModels.map((entry) => entry.readModelId),
			expectedOwnedIds(slice, readModelById),
			"readModels",
		);
		requireExactRows(
			strategy.access.map((entry) => entry.accessPolicyId),
			expectedOwnedIds(slice, accessById),
			"access",
		);
		requireExactRows(
			strategy.navigation.map((entry) => entry.navigationId),
			expectedOwnedIds(slice, navigationById),
			"navigation",
		);

		for (const [j, binding] of strategy.tasks.entries()) {
			if (!ownedIntentIds.has(binding.taskId)) continue;
			const task = taskById.get(binding.taskId);
			if (task === undefined) continue;
			if (binding.contextRecordId !== task.contextRecordId) {
				issue(
					["slices", i, "constructionStrategy", "tasks", j, "contextRecordId"],
					"A task's selected-case context must match the accepted contract exactly.",
				);
			}
			if (!sameIds(binding.transitionIds, task.transitionIds)) {
				issue(
					["slices", i, "constructionStrategy", "tasks", j, "transitionIds"],
					"A task strategy must name exactly the task's accepted lifecycle transitions.",
				);
			}
			const hasCreate = task.transitionIds.some(
				(id) => transitionById.get(id)?.transitionKind === "create",
			);
			const expectedMode =
				task.contextRecordId !== undefined
					? "case-action"
					: hasCreate
						? "registration"
						: "survey";
			if (binding.mode !== expectedMode) {
				issue(
					["slices", i, "constructionStrategy", "tasks", j, "mode"],
					`This task requires ${expectedMode} mode from its selected-case context and transitions.`,
				);
			}
			if (expectedMode === "registration") {
				const primaryId = binding.primaryCreateTransitionId;
				if (
					primaryId === undefined ||
					!binding.transitionIds.includes(primaryId) ||
					transitionById.get(primaryId)?.transitionKind !== "create"
				) {
					issue(
						[
							"slices",
							i,
							"constructionStrategy",
							"tasks",
							j,
							"primaryCreateTransitionId",
						],
						"A registration task must name exactly one of its accepted create transitions as the ordinary primary registration action.",
					);
				}
			} else if (binding.primaryCreateTransitionId !== undefined) {
				issue(
					[
						"slices",
						i,
						"constructionStrategy",
						"tasks",
						j,
						"primaryCreateTransitionId",
					],
					"Only a registration task may name a primary registration create.",
				);
			}
		}

		const writerForSource = (
			kind: (typeof contract.facts)[number]["source"]["kind"],
		) =>
			({
				answer: "task-input",
				derived: "calculation",
				session: "session",
				lookup: "lookup",
				external: "external",
				constant: "constant",
			})[kind] as (typeof strategy.facts)[number]["writer"];
		for (const [j, binding] of strategy.facts.entries()) {
			if (!ownedIntentIds.has(binding.factId)) continue;
			const fact = factById.get(binding.factId);
			if (fact === undefined) continue;
			if (binding.storage !== "case-property") {
				issue(
					["slices", i, "constructionStrategy", "facts", j, "storage"],
					"A contract fact is durable record data and must lower to a case property; form-only values belong in task inputs, not facts.",
				);
			}
			const expectedWriter = writerForSource(fact.source.kind);
			if (binding.writer !== expectedWriter) {
				issue(
					["slices", i, "constructionStrategy", "facts", j, "writer"],
					`This fact's accepted source requires the ${expectedWriter} writer.`,
				);
			}
			if (binding.unanswered !== "preserve") {
				issue(
					["slices", i, "constructionStrategy", "facts", j, "unanswered"],
					"The contract does not authorize clearing this fact when an input is unanswered; preserve the existing value.",
				);
			}
		}

		for (const [j, binding] of strategy.readModels.entries()) {
			if (!ownedIntentIds.has(binding.readModelId)) continue;
			const readModel = readModelById.get(binding.readModelId);
			if (readModel === undefined) continue;
			const lowering = strategy.lowerings.find(
				(entry) => entry.intentId === binding.readModelId,
			);
			if (lowering?.target !== binding.mode) {
				issue(
					["slices", i, "constructionStrategy", "lowerings"],
					`Read model ${binding.readModelId} must lower to its explicit ${binding.mode} construction mode.`,
				);
			}
			if (!sameIds(binding.searchFilterFactIds, readModel.searchFactIds)) {
				issue(
					[
						"slices",
						i,
						"constructionStrategy",
						"readModels",
						j,
						"searchFilterFactIds",
					],
					"Search filters must cover exactly the accepted read model's search facts.",
				);
			}
			const navigationActorSets = contract.navigation
				.filter((entry) => entry.readModelIds.includes(readModel.id))
				.map((entry) => [...entry.actorIds].sort().join("\u0000"));
			const hasDistinctNavigationPartitions =
				new Set(navigationActorSets).size > 1;
			const navigationActors = new Set(
				contract.navigation
					.filter((entry) => entry.readModelIds.includes(readModel.id))
					.flatMap((entry) => entry.actorIds),
			);
			const navigationOmitsActors =
				navigationActors.size > 0 &&
				!sameIds([...navigationActors], readModel.actorIds);
			const hasTargetedAccess = contract.accessPolicies.some((policy) =>
				policy.targetIntentIds.includes(readModel.id),
			);
			const expectedRolePartition = hasDistinctNavigationPartitions
				? "separate-navigation"
				: hasTargetedAccess || navigationOmitsActors
					? "actor-gated"
					: "shared";
			if (binding.rolePartition !== expectedRolePartition) {
				issue(
					[
						"slices",
						i,
						"constructionStrategy",
						"readModels",
						j,
						"rolePartition",
					],
					`This read model requires ${expectedRolePartition} role partitioning from its accepted actors, access policies, and navigation entries.`,
				);
			}
		}

		for (const [j, binding] of strategy.access.entries()) {
			if (!ownedIntentIds.has(binding.accessPolicyId)) continue;
			const policy = accessById.get(binding.accessPolicyId);
			if (policy === undefined) continue;
			const layers = new Set(binding.layers);
			if (
				policy.condition !== undefined &&
				!layers.has("navigation-visibility")
			) {
				issue(
					["slices", i, "constructionStrategy", "access", j, "layers"],
					"A conditional access policy must state its navigation-visibility gate.",
				);
			}
			if (
				policy.locationScopeIntent !== undefined &&
				(!layers.has("location-scope") || !layers.has("search-filter"))
			) {
				issue(
					["slices", i, "constructionStrategy", "access", j, "layers"],
					"Location-scoped access requires both the location scope and the matching search filter.",
				);
			}
			if (
				(policy.capability === "discover" || policy.capability === "view") &&
				!(
					[
						"case-context",
						"location-scope",
						"search-filter",
						"manual-setup",
					] as const
				).some((layer) => layers.has(layer))
			) {
				issue(
					["slices", i, "constructionStrategy", "access", j, "layers"],
					"Discover/view access cannot rely only on hidden navigation; name the data-access or explicit setup layer that enforces it.",
				);
			}
		}
	});

	/* Exact ownership coverage. */
	const owned = new Map<string, IntentOwnershipEntry>(
		plan.intentOwnership.map((e) => [e.intentId, e]),
	);
	for (const intentId of implementable) {
		if (!owned.has(intentId)) {
			issue(
				["intentOwnership"],
				"An implementable intent of the accepted contract has no owning slice. Every record, fact, rule, task, transition, read model, access policy, and navigation intent needs exactly one owner.",
			);
			break; /* one message; the planner regenerates wholesale */
		}
	}
	plan.intentOwnership.forEach((entry, i) => {
		if (!implementable.has(entry.intentId)) {
			issue(
				["intentOwnership", i, "intentId"],
				"This ownership row names an id that is not an implementable intent of the accepted contract.",
			);
		}
	});

	/* Every scenario is somebody's acceptance evidence. */
	const claimedScenarios = new Set(
		plan.slices.flatMap((slice) => slice.acceptanceScenarioIds),
	);
	contract.acceptanceScenarios.forEach((scenario, i) => {
		if (!claimedScenarios.has(scenario.id)) {
			issue(
				["slices"],
				`The acceptance scenario "${scenario.name}" belongs to no slice — every scenario is owned acceptance evidence (contract scenario index ${i}).`,
			);
		}
	});

	/* Parent selection precedes child creation. */
	const parentReadModelRecordIds = (sliceId: string): Set<string> => {
		const seen = new Set<string>();
		const records = new Set<string>();
		const queue = [sliceId];
		while (queue.length > 0) {
			const id = queue.pop() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			const slice = sliceById.get(id);
			if (!slice) continue;
			for (const intentId of slice.intentIds) {
				const model = contract.readModels.find((m) => m.id === intentId);
				if (model) records.add(model.recordId);
			}
			queue.push(...slice.prerequisiteSliceIds);
		}
		return records;
	};
	plan.slices.forEach((slice, i) => {
		const reachable = parentReadModelRecordIds(slice.id);
		for (const intentId of slice.ownedIntentIds) {
			const task = taskById.get(intentId);
			if (!task) continue;
			for (const transitionId of task.transitionIds) {
				const transition = transitionById.get(transitionId);
				if (transition?.transitionKind !== "create") continue;
				const record = recordById.get(transition.targetRecordId);
				if (!record?.parentRecordId) continue;
				if (!reachable.has(record.parentRecordId)) {
					issue(
						["slices", i, "intentIds"],
						`The slice "${slice.name}" owns the task "${task.name}", which creates a child record — but no slice in its prerequisite closure carries a read model over the parent record. The worker must be able to select the parent first; plan that read model into this slice or a prerequisite.`,
					);
				}
			}
		}
	});
}
