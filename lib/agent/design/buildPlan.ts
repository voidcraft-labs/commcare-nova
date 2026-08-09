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
		expectedBlueprintAreas: z.array(blueprintAreaSchema),
		externalActionIds: z.array(designIdSchema),
	})
	.strict();
export type BuildSlice = z.infer<typeof buildSliceSchema>;

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
		schemaVersion: z.literal(2),
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

/** Admission policy for newly produced plans. This deliberately stays out of
 * `buildPlanSchema`: persisted artifacts accepted before a producer rollout
 * remain readable and can reach the orchestrator's fail-closed receipt check.
 * New plans may not introduce a blocking action until its producer exists. */
export function unsupportedBlockingActionMessages(
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

	plan.slices.forEach((slice, i) => {
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
	const recordById = new Map(contract.records.map((r) => [r.id, r]));
	const transitionById = new Map(contract.transitions.map((t) => [t.id, t]));
	const taskById = new Map(contract.tasks.map((t) => [t.id, t]));
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
