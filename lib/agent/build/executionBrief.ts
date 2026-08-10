/**
 * The slice execution brief — the one immutable, digest-bound description of
 * WHAT one slice executor must implement (the plan's §8.5 / §13.4).
 *
 * A brief is derived, never authored: it is the accepted Design Contract
 * narrowed to one Build Slice's transitive reference closure, plus the
 * closed platform-constraint catalogue the executor lowers against. It
 * carries pointers and typed design objects only — never a raw attachment
 * body, never model reasoning, and never a mutable "latest contract"
 * pointer: the revision/plan identity and digest ON the brief are what the
 * orchestrator re-proves before every executor call, so an obsolete brief is
 * superseded rather than adapted.
 *
 * The brief and the workspace summary are the VOLATILE half of the executor
 * prompt; the system prompt (`executorPrompt.ts`) stays byte-static so the
 * provider's exact-prefix cache holds across slices.
 */

import type {
	BuildPlan,
	BuildSlice,
	ExternalAction,
} from "@/lib/agent/design/buildPlan";
import type {
	AcceptanceScenario,
	AccessPolicy,
	AppDesignContract,
	ArchitectureDecision,
	Assumption,
	DesignActor,
	FactDefinition,
	LifecycleTransition,
	LookupTableIntent,
	NavigationIntent,
	ReadModel,
	RecordConcept,
	RuleIntent,
	Task,
} from "@/lib/agent/design/contract";
import type { DesignId } from "@/lib/agent/design/ids";
import {
	PLATFORM_CONSTRAINTS,
	type PlatformConstraint,
} from "@/lib/agent/design/platformConstraints";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

/**
 * One slice's complete execution context.
 *
 * `owningIntentIds` are the intents this slice must land — the completion
 * unit the orchestrator marks off. `dependencyIntentIds` are everything else
 * the closure reached: context the executor reads to build coherently but
 * does not own, and must not re-implement.
 */
export interface SliceExecutionBrief {
	readonly schemaVersion: 1;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly appObjective: string;
	readonly slice: BuildSlice;
	readonly owningIntentIds: readonly DesignId[];
	readonly dependencyIntentIds: readonly DesignId[];
	readonly actors: readonly DesignActor[];
	readonly tasks: readonly Task[];
	readonly records: readonly RecordConcept[];
	readonly facts: readonly FactDefinition[];
	readonly rules: readonly RuleIntent[];
	readonly transitions: readonly LifecycleTransition[];
	readonly readModels: readonly ReadModel[];
	readonly accessPolicies: readonly AccessPolicy[];
	readonly navigation: readonly NavigationIntent[];
	readonly lookupIntents: readonly LookupTableIntent[];
	readonly decisions: readonly ArchitectureDecision[];
	readonly scenarios: readonly AcceptanceScenario[];
	readonly assumptions: readonly Assumption[];
	readonly externalActions: readonly ExternalAction[];
	readonly loweringConstraints: readonly PlatformConstraint[];
}

/**
 * The reference edges the closure walks. Each edge is a REFERENCE the design
 * graph validator already proved resolvable, so the walk is total: an id that
 * names nothing is simply not reached.
 *
 * Deliberately NOT edges: a fact's `writerTaskIds` / `readerIds` and a rule's
 * membership in some other task. Those are the whole-contract coherence graph
 * — following them pulls the entire app into every brief, which is exactly the
 * "module-by-module sketch" the slice boundary exists to prevent. A slice
 * reaches what it needs to BUILD its intents; another slice's readers of the
 * same fact are that slice's business.
 */
interface ContractIndex {
	readonly kindById: ReadonlyMap<string, string>;
	readonly taskByInputId: ReadonlyMap<string, Task>;
	readonly lookupIntentByColumnId: ReadonlyMap<string, LookupTableIntent>;
	readonly outboundById: ReadonlyMap<string, readonly string[]>;
}

function indexContract(contract: AppDesignContract): ContractIndex {
	const kindById = new Map<string, string>();
	const taskByInputId = new Map<string, Task>();
	const lookupIntentByColumnId = new Map<string, LookupTableIntent>();
	const outboundById = new Map<string, readonly string[]>();

	for (const actor of contract.actors) kindById.set(actor.id, "actor");
	for (const record of contract.records) kindById.set(record.id, "record");
	for (const fact of contract.facts) kindById.set(fact.id, "fact");
	for (const rule of contract.rules) kindById.set(rule.id, "rule");
	for (const task of contract.tasks) {
		kindById.set(task.id, "task");
		for (const input of task.inputs) taskByInputId.set(input.id, task);
	}
	for (const transition of contract.transitions) {
		kindById.set(transition.id, "transition");
	}
	for (const model of contract.readModels) kindById.set(model.id, "readModel");
	for (const intent of contract.lookupIntents) {
		kindById.set(intent.id, "lookupIntent");
		for (const column of intent.columns) {
			lookupIntentByColumnId.set(column.id, intent);
		}
	}
	for (const policy of contract.accessPolicies) {
		kindById.set(policy.id, "accessPolicy");
	}
	for (const nav of contract.navigation) kindById.set(nav.id, "navigation");

	const defined = (...ids: (string | undefined)[]): string[] =>
		ids.filter((id): id is string => id !== undefined);

	for (const record of contract.records) {
		outboundById.set(record.id, defined(record.parentRecordId));
	}
	for (const fact of contract.facts) {
		const source = fact.source;
		const fromSource =
			source.kind === "answer"
				? defined(taskByInputId.get(source.taskInputId)?.id)
				: source.kind === "derived"
					? [source.ruleId]
					: source.kind === "lookup"
						? defined(
								source.lookupIntentId,
								lookupIntentByColumnId.get(source.columnIntentId)?.id,
							)
						: [];
		outboundById.set(fact.id, [fact.recordId, ...fromSource]);
	}
	for (const rule of contract.rules) {
		/* A rule input is a fact or a task input; a task input resolves to the
		 * task that asks it. */
		const inputs = rule.inputIds.flatMap((id) =>
			defined(kindById.has(id) ? id : taskByInputId.get(id)?.id),
		);
		outboundById.set(rule.id, [...inputs, ...rule.outputFactIds]);
	}
	for (const task of contract.tasks) {
		outboundById.set(task.id, [
			task.actorId,
			...defined(task.contextRecordId),
			...task.decisionRuleIds,
			...task.transitionIds,
			...task.readBackIds,
			...task.inputs.flatMap((input) => defined(input.factId)),
			...task.writes.flatMap((write) => [
				write.targetFactId,
				...defined(write.ruleId),
			]),
		]);
	}
	for (const transition of contract.transitions) {
		outboundById.set(transition.id, [
			...defined(transition.sourceRecordId),
			transition.targetRecordId,
			...defined(transition.conditionRuleId),
			...transition.writes.flatMap((write) => [
				write.targetFactId,
				...defined(write.ruleId),
			]),
		]);
	}
	for (const model of contract.readModels) {
		outboundById.set(model.id, [
			...model.actorIds,
			model.recordId,
			...model.scanFactIds,
			...model.detailFactIds,
			...model.searchFactIds,
			...defined(model.selectionTaskId),
		]);
	}
	for (const policy of contract.accessPolicies) {
		outboundById.set(policy.id, [policy.actorId, ...policy.targetIntentIds]);
	}
	for (const nav of contract.navigation) {
		outboundById.set(nav.id, [
			...nav.actorIds,
			...nav.entryTaskIds,
			...nav.readModelIds,
			...defined(nav.parentNavigationId),
		]);
	}

	return { kindById, taskByInputId, lookupIntentByColumnId, outboundById };
}

/** The transitive closure over the contract graph from one slice's intents. */
function referenceClosure(
	index: ContractIndex,
	seeds: readonly DesignId[],
): ReadonlySet<string> {
	const reached = new Set<string>();
	const queue: string[] = [];
	const enqueue = (id: string): void => {
		/* Resolve a nested id (a task input, a lookup column) to the top-level
		 * member that owns it — collections carry members, never fragments. */
		const owner =
			index.kindById.has(id) === true
				? id
				: (index.taskByInputId.get(id)?.id ??
					index.lookupIntentByColumnId.get(id)?.id);
		if (owner === undefined || reached.has(owner)) return;
		reached.add(owner);
		queue.push(owner);
	};
	for (const seed of seeds) enqueue(seed);
	while (queue.length > 0) {
		const id = queue.pop() as string;
		for (const next of index.outboundById.get(id) ?? []) enqueue(next);
	}
	return reached;
}

/**
 * Derive one slice's brief from the accepted contract and plan.
 *
 * Collection membership is exactly the closure; ORDER is always the
 * contract's own member order, so two derivations of the same inputs are
 * byte-identical and `briefDigest` is a stable identity.
 *
 * Three collections are deliberately not closure-filtered:
 *  - every acceptance scenario the slice CLAIMS (its acceptance evidence,
 *    whatever else it references);
 *  - all decisions and assumptions (contract-level context — an executor that
 *    cannot see the rejected option re-litigates the architecture);
 *  - the whole platform-constraint catalogue (the closed lowering vocabulary;
 *    a constraint the executor does not know is one it violates).
 */
export function deriveSliceExecutionBrief(args: {
	readonly contract: AppDesignContract;
	readonly revision: { readonly id: string; readonly digest: string };
	readonly plan: BuildPlan;
	readonly sliceId: DesignId;
	/**
	 * The plan's ARTIFACT digest, when the caller holds it (it is an
	 * envelope-scoped identity the plan body only references). Pass it so the
	 * brief's `buildPlanDigest` is the same value the slice attempt records
	 * and the orchestrator re-proves against the artifact store. Omitted, the
	 * brief falls back to the content digest over the exact plan body — still
	 * a stable identity any holder of the same plan recomputes, but not the
	 * one the artifact store knows.
	 */
	readonly planDigest?: string;
}): SliceExecutionBrief {
	const slice = args.plan.slices.find((entry) => entry.id === args.sliceId);
	if (slice === undefined) {
		throw new Error(
			`Build plan ${args.plan.id} holds no slice ${args.sliceId}. A brief is derived from the plan the orchestrator accepted; re-plan or name a slice this plan contains.`,
		);
	}

	const contract = args.contract;
	const index = indexContract(contract);
	const closure = referenceClosure(index, slice.intentIds);
	const inClosure = <T extends { readonly id: string }>(
		members: readonly T[],
	): T[] => members.filter((member) => closure.has(member.id));

	const owned = new Set<string>(slice.ownedIntentIds);
	const claimedScenarios = new Set<string>(slice.acceptanceScenarioIds);
	const sliceActions = new Set<string>(slice.externalActionIds);

	const actors = inClosure(contract.actors);
	const records = inClosure(contract.records);
	const facts = inClosure(contract.facts);
	const rules = inClosure(contract.rules);
	const tasks = inClosure(contract.tasks);
	const transitions = inClosure(contract.transitions);
	const readModels = inClosure(contract.readModels);
	const lookupIntents = inClosure(contract.lookupIntents);
	const accessPolicies = inClosure(contract.accessPolicies);
	const navigation = inClosure(contract.navigation);

	/* Dependency ids in the brief's own presentation order, so the list reads
	 * alongside the collections that carry them. */
	const dependencyIntentIds = [
		...actors,
		...records,
		...facts,
		...rules,
		...tasks,
		...transitions,
		...readModels,
		...lookupIntents,
		...accessPolicies,
		...navigation,
	]
		.map((member) => member.id as DesignId)
		.filter((id) => !owned.has(id));

	return {
		schemaVersion: 1,
		designRevisionId: args.revision.id,
		designRevisionDigest: args.revision.digest,
		buildPlanId: args.plan.id,
		buildPlanDigest: args.planDigest ?? canonicalJsonDigest(args.plan),
		appObjective: contract.objective,
		slice,
		owningIntentIds: [...slice.ownedIntentIds],
		dependencyIntentIds,
		actors,
		tasks,
		records,
		facts,
		rules,
		transitions,
		readModels,
		accessPolicies,
		navigation,
		lookupIntents,
		decisions: [...contract.decisions],
		scenarios: contract.acceptanceScenarios.filter((scenario) =>
			claimedScenarios.has(scenario.id),
		),
		assumptions: [...contract.assumptions],
		externalActions: args.plan.externalActions.filter((action) =>
			sliceActions.has(action.id),
		),
		loweringConstraints: Object.values(PLATFORM_CONSTRAINTS),
	};
}

/** The brief's stable identity — persisted on the slice attempt and re-proved
 *  before every executor call. */
export function briefDigest(brief: SliceExecutionBrief): string {
	return canonicalJsonDigest(brief);
}

function section(heading: string, body: string): string {
	return `## ${heading}\n${body}`;
}

/** One collection as labeled JSON — one member per line, so a long brief stays
 *  scannable and a single member is never truncated mid-object. */
function jsonSection(
	heading: string,
	members: readonly unknown[],
): string | null {
	if (members.length === 0) return null;
	return section(
		heading,
		members.map((member) => JSON.stringify(member)).join("\n"),
	);
}

/**
 * Render the brief as the executor's ONE volatile user message.
 *
 * Compact and complete: the objective, this slice's identity and goal, what
 * it owns versus what it merely depends on, then each nonempty collection.
 * No raw source bodies, no reasoning, no mutable pointers — everything here
 * is already in the digest-bound brief.
 */
export function renderBriefMessage(brief: SliceExecutionBrief): string {
	const slice = brief.slice;
	const blocks: (string | null)[] = [
		section(
			"App objective",
			`${brief.appObjective}\n\nDesign revision ${brief.designRevisionId} (${brief.designRevisionDigest}), build plan ${brief.buildPlanId}.`,
		),
		section(
			"This slice",
			[
				`${slice.name} — ${slice.goal}`,
				`Role: ${slice.role}. Risk: ${slice.risk}.`,
				`Construction strategy: ${JSON.stringify(slice.constructionStrategy)}`,
				`Intents this slice OWNS and must land: ${brief.owningIntentIds.join(", ")}`,
				brief.dependencyIntentIds.length > 0
					? `Intents it depends on but does NOT own (context — another slice owns them): ${brief.dependencyIntentIds.join(", ")}`
					: "This slice depends on no intent it does not own.",
			].join("\n"),
		),
		jsonSection("Actors", brief.actors),
		jsonSection("Records", brief.records),
		jsonSection("Facts", brief.facts),
		jsonSection("Rules", brief.rules),
		jsonSection("Tasks", brief.tasks),
		jsonSection("Lifecycle transitions", brief.transitions),
		jsonSection("Read models", brief.readModels),
		jsonSection("Access policies", brief.accessPolicies),
		jsonSection("Navigation", brief.navigation),
		jsonSection("Reference-data (lookup) intents", brief.lookupIntents),
		jsonSection("Architecture decisions", brief.decisions),
		jsonSection("Assumptions", brief.assumptions),
		jsonSection(
			"Acceptance scenarios this slice must satisfy",
			brief.scenarios,
		),
		jsonSection("External actions bound to this slice", brief.externalActions),
		section(
			"Platform constraints you lower against",
			brief.loweringConstraints
				.map(
					(constraint) =>
						`- ${constraint.code}: ${constraint.statement} (${constraint.sourceAnchor})`,
				)
				.join("\n"),
		),
	];
	return blocks.filter((block): block is string => block !== null).join("\n\n");
}
