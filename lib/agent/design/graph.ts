/**
 * validateDesignGraph — the deterministic internal-coherence proof of one
 * Design Contract.
 *
 * Runs inside the contract schema's parse (`contract.ts`), so it executes
 * everywhere the schema does: before review, after revision, before build
 * planning, and on every persisted read. It is NOT the Blueprint validator —
 * it proves the design graph is closed and coherent, never that an app is
 * constructible.
 *
 * What it proves:
 *  1. every Design ID (including nested inputs, write intents, and decision
 *     options) is unique across the whole contract;
 *  2. every reference resolves to an existing id of a compatible kind, and
 *     every `evidence` entry points to a source claim;
 *  3. nested ids stay inside their parent: a decision's selected option
 *     belongs to that decision (and option ids are referenced from nowhere
 *     else), and a lookup-sourced fact's column belongs to the lookup table
 *     that fact names;
 *  4. every explicit source claim is represented by at least one OWNING
 *     intent (record, fact, rule, task, transition, read model, or access
 *     policy listing it as evidence) or explicitly deferred;
 *  5. fact writer sets equal the tasks that actually write the fact
 *     (directly or through a transition they trigger), and
 *     `taskInput.factId` ⇄ `fact.source.answer.taskInputId` are mutually
 *     coherent;
 *  6. every transition write targets a fact of the transition's target
 *     record;
 *  7. the record parent graph and the navigation parent graph are acyclic;
 *  8. every blocking open question names at least one affected intent or
 *     architecture decision;
 *  9. every acceptance scenario exercises at least one task, transition, or
 *     read model.
 *
 * Sensitivity-lowering (§ the reviser rule) is a revision-PAIR property and
 * is enforced in the reviser call (`reviser.ts`), not here.
 */

import type { z } from "zod";
import type {
	AppDesignContract,
	FactDefinition,
} from "@/lib/agent/design/contract";

type RefinementCtx = z.RefinementCtx;
type IssuePath = Array<string | number>;

type DesignKind =
	| "source claim"
	| "actor"
	| "record"
	| "fact"
	| "rule"
	| "task"
	| "task input"
	| "write intent"
	| "transition"
	| "read model"
	| "lookup intent"
	| "lookup column intent"
	| "access policy"
	| "navigation intent"
	| "architecture decision"
	| "decision option"
	| "assumption"
	| "open question"
	| "acceptance scenario"
	| "contract";

/** Kinds an open question or scenario may relate to — every intent-shaped
 *  object plus decisions; never claims or another decision's options. */
const RELATABLE_KINDS: readonly DesignKind[] = [
	"actor",
	"record",
	"fact",
	"rule",
	"task",
	"task input",
	"transition",
	"read model",
	"lookup intent",
	"access policy",
	"navigation intent",
	"architecture decision",
	"acceptance scenario",
];

/** Kinds an access policy may target — the objects a capability verb can
 *  apply to. */
const ACCESS_TARGET_KINDS: readonly DesignKind[] = [
	"record",
	"fact",
	"task",
	"transition",
	"read model",
	"navigation intent",
];

/** Kinds that may read a fact. */
const FACT_READER_KINDS: readonly DesignKind[] = ["task", "rule", "read model"];

export function validateDesignGraph(
	contract: AppDesignContract,
	ctx: RefinementCtx,
): void {
	const kinds = new Map<string, DesignKind>();
	const issue = (path: IssuePath, message: string) =>
		ctx.addIssue({ code: "custom", path, message });

	/* ---- 1. one namespace, unique ids -------------------------------- */
	const register = (id: string, kind: DesignKind, path: IssuePath) => {
		const existing = kinds.get(id);
		if (existing !== undefined) {
			issue(
				path,
				`This ${kind}'s id is already used by a ${existing}. Every design id must be unique across the whole contract — mint a fresh UUID for one of them.`,
			);
			return;
		}
		kinds.set(id, kind);
	};

	register(contract.id, "contract", ["id"]);
	contract.sourceClaims.forEach((claim, i) => {
		register(claim.id, "source claim", ["sourceClaims", i, "id"]);
	});
	contract.actors.forEach((actor, i) => {
		register(actor.id, "actor", ["actors", i, "id"]);
	});
	contract.records.forEach((record, i) => {
		register(record.id, "record", ["records", i, "id"]);
	});
	contract.facts.forEach((fact, i) => {
		register(fact.id, "fact", ["facts", i, "id"]);
	});
	contract.rules.forEach((rule, i) => {
		register(rule.id, "rule", ["rules", i, "id"]);
	});
	contract.tasks.forEach((task, i) => {
		register(task.id, "task", ["tasks", i, "id"]);
		task.inputs.forEach((input, j) => {
			register(input.id, "task input", ["tasks", i, "inputs", j, "id"]);
		});
		task.writes.forEach((write, j) => {
			register(write.id, "write intent", ["tasks", i, "writes", j, "id"]);
		});
	});
	contract.transitions.forEach((transition, i) => {
		register(transition.id, "transition", ["transitions", i, "id"]);
		transition.writes.forEach((write, j) => {
			register(write.id, "write intent", ["transitions", i, "writes", j, "id"]);
		});
	});
	contract.readModels.forEach((model, i) => {
		register(model.id, "read model", ["readModels", i, "id"]);
	});
	contract.lookupIntents.forEach((table, i) => {
		register(table.id, "lookup intent", ["lookupIntents", i, "id"]);
		table.columns.forEach((column, j) => {
			register(column.id, "lookup column intent", [
				"lookupIntents",
				i,
				"columns",
				j,
				"id",
			]);
		});
	});
	contract.accessPolicies.forEach((policy, i) => {
		register(policy.id, "access policy", ["accessPolicies", i, "id"]);
	});
	contract.navigation.forEach((nav, i) => {
		register(nav.id, "navigation intent", ["navigation", i, "id"]);
	});
	contract.decisions.forEach((decision, i) => {
		register(decision.id, "architecture decision", ["decisions", i, "id"]);
		decision.options.forEach((option, j) => {
			register(option.id, "decision option", [
				"decisions",
				i,
				"options",
				j,
				"id",
			]);
		});
	});
	contract.assumptions.forEach((assumption, i) => {
		register(assumption.id, "assumption", ["assumptions", i, "id"]);
	});
	contract.openQuestions.forEach((question, i) => {
		register(question.id, "open question", ["openQuestions", i, "id"]);
	});
	contract.acceptanceScenarios.forEach((scenario, i) => {
		register(scenario.id, "acceptance scenario", [
			"acceptanceScenarios",
			i,
			"id",
		]);
	});

	/* ---- 2. reference closure with kind compatibility ---------------- */
	const ref = (
		id: string,
		allowed: readonly DesignKind[],
		path: IssuePath,
		role: string,
	) => {
		const kind = kinds.get(id);
		if (kind === undefined) {
			issue(
				path,
				`${role} references a design id that appears nowhere in this contract. Point it at an existing ${formatKinds(allowed)}, or add the missing object.`,
			);
			return;
		}
		if (!allowed.includes(kind)) {
			issue(
				path,
				`${role} must reference a ${formatKinds(allowed)}, but this id belongs to a ${kind}.`,
			);
		}
	};
	const refs = (
		ids: readonly string[],
		allowed: readonly DesignKind[],
		path: IssuePath,
		role: string,
	) => {
		ids.forEach((id, i) => {
			ref(id, allowed, [...path, i], role);
		});
	};
	const evidenceRefs = (ids: readonly string[], path: IssuePath) => {
		refs(ids, ["source claim"], path, "An evidence entry");
	};

	/** Which lookup table each column intent belongs to — the oracle behind
	 *  rule 3's containment law for lookup-sourced facts. */
	const lookupTableByColumnId = new Map<string, string>();
	for (const table of contract.lookupIntents) {
		for (const column of table.columns) {
			lookupTableByColumnId.set(column.id, table.id);
		}
	}

	contract.actors.forEach((actor, i) => {
		evidenceRefs(actor.evidence, ["actors", i, "evidence"]);
	});
	contract.records.forEach((record, i) => {
		evidenceRefs(record.evidence, ["records", i, "evidence"]);
		if (record.parentRecordId !== undefined) {
			ref(
				record.parentRecordId,
				["record"],
				["records", i, "parentRecordId"],
				"A record's parent",
			);
		}
	});
	contract.facts.forEach((fact, i) => {
		evidenceRefs(fact.evidence, ["facts", i, "evidence"]);
		ref(fact.recordId, ["record"], ["facts", i, "recordId"], "A fact's record");
		refs(
			fact.writerTaskIds,
			["task"],
			["facts", i, "writerTaskIds"],
			"A fact writer",
		);
		refs(
			fact.readerIds,
			FACT_READER_KINDS,
			["facts", i, "readerIds"],
			"A fact reader",
		);
		const source = fact.source;
		if (source.kind === "answer") {
			ref(
				source.taskInputId,
				["task input"],
				["facts", i, "source", "taskInputId"],
				"An answer-sourced fact",
			);
		} else if (source.kind === "derived") {
			ref(
				source.ruleId,
				["rule"],
				["facts", i, "source", "ruleId"],
				"A derived fact's rule",
			);
		} else if (source.kind === "lookup") {
			ref(
				source.lookupIntentId,
				["lookup intent"],
				["facts", i, "source", "lookupIntentId"],
				"A lookup-sourced fact's table",
			);
			ref(
				source.columnIntentId,
				["lookup column intent"],
				["facts", i, "source", "columnIntentId"],
				"A lookup-sourced fact's column",
			);
			/* ---- 3. the column belongs to the table this fact names ------ */
			const owningTableId = lookupTableByColumnId.get(source.columnIntentId);
			if (
				owningTableId !== undefined &&
				owningTableId !== source.lookupIntentId
			) {
				issue(
					["facts", i, "source", "columnIntentId"],
					`The fact "${fact.name}" reads a column that belongs to a different lookup table than the one it names. Point the fact at a column of that table, or name the table the column actually belongs to.`,
				);
			}
		}
	});
	contract.rules.forEach((rule, i) => {
		evidenceRefs(rule.evidence, ["rules", i, "evidence"]);
		refs(
			rule.inputIds,
			["fact", "task input"],
			["rules", i, "inputIds"],
			"A rule input",
		);
		refs(
			rule.outputFactIds,
			["fact"],
			["rules", i, "outputFactIds"],
			"A rule output",
		);
	});
	contract.tasks.forEach((task, i) => {
		evidenceRefs(task.evidence, ["tasks", i, "evidence"]);
		ref(task.actorId, ["actor"], ["tasks", i, "actorId"], "A task's actor");
		if (task.contextRecordId !== undefined) {
			ref(
				task.contextRecordId,
				["record"],
				["tasks", i, "contextRecordId"],
				"A task's context record",
			);
		}
		refs(
			task.decisionRuleIds,
			["rule"],
			["tasks", i, "decisionRuleIds"],
			"A task decision rule",
		);
		refs(
			task.transitionIds,
			["transition"],
			["tasks", i, "transitionIds"],
			"A task transition",
		);
		refs(
			task.readBackIds,
			["read model", "fact"],
			["tasks", i, "readBackIds"],
			"A task read-back",
		);
		task.inputs.forEach((input, j) => {
			evidenceRefs(input.evidence, ["tasks", i, "inputs", j, "evidence"]);
			if (input.factId !== undefined) {
				ref(
					input.factId,
					["fact"],
					["tasks", i, "inputs", j, "factId"],
					"A task input's fact",
				);
			}
		});
		task.writes.forEach((write, j) => {
			ref(
				write.targetFactId,
				["fact"],
				["tasks", i, "writes", j, "targetFactId"],
				"A write intent",
			);
			if (write.ruleId !== undefined) {
				ref(
					write.ruleId,
					["rule"],
					["tasks", i, "writes", j, "ruleId"],
					"A write intent's rule",
				);
			}
		});
	});
	contract.transitions.forEach((transition, i) => {
		evidenceRefs(transition.evidence, ["transitions", i, "evidence"]);
		if (transition.sourceRecordId !== undefined) {
			ref(
				transition.sourceRecordId,
				["record"],
				["transitions", i, "sourceRecordId"],
				"A transition's source record",
			);
		}
		ref(
			transition.targetRecordId,
			["record"],
			["transitions", i, "targetRecordId"],
			"A transition's target record",
		);
		if (transition.conditionRuleId !== undefined) {
			ref(
				transition.conditionRuleId,
				["rule"],
				["transitions", i, "conditionRuleId"],
				"A transition's condition rule",
			);
		}
		transition.writes.forEach((write, j) => {
			ref(
				write.targetFactId,
				["fact"],
				["transitions", i, "writes", j, "targetFactId"],
				"A transition write",
			);
			if (write.ruleId !== undefined) {
				ref(
					write.ruleId,
					["rule"],
					["transitions", i, "writes", j, "ruleId"],
					"A transition write's rule",
				);
			}
		});
	});
	contract.readModels.forEach((model, i) => {
		evidenceRefs(model.evidence, ["readModels", i, "evidence"]);
		refs(
			model.actorIds,
			["actor"],
			["readModels", i, "actorIds"],
			"A read model's actor",
		);
		ref(
			model.recordId,
			["record"],
			["readModels", i, "recordId"],
			"A read model's record",
		);
		refs(
			model.scanFactIds,
			["fact"],
			["readModels", i, "scanFactIds"],
			"A scan fact",
		);
		refs(
			model.detailFactIds,
			["fact"],
			["readModels", i, "detailFactIds"],
			"A detail fact",
		);
		refs(
			model.searchFactIds,
			["fact"],
			["readModels", i, "searchFactIds"],
			"A search fact",
		);
		if (model.selectionTaskId !== undefined) {
			ref(
				model.selectionTaskId,
				["task"],
				["readModels", i, "selectionTaskId"],
				"A read model's selection task",
			);
		}
	});
	contract.lookupIntents.forEach((table, i) => {
		evidenceRefs(table.evidence, ["lookupIntents", i, "evidence"]);
		table.columns.forEach((column, j) => {
			evidenceRefs(column.evidence, [
				"lookupIntents",
				i,
				"columns",
				j,
				"evidence",
			]);
		});
	});
	contract.accessPolicies.forEach((policy, i) => {
		evidenceRefs(policy.evidence, ["accessPolicies", i, "evidence"]);
		ref(
			policy.actorId,
			["actor"],
			["accessPolicies", i, "actorId"],
			"An access policy's actor",
		);
		refs(
			policy.targetIntentIds,
			ACCESS_TARGET_KINDS,
			["accessPolicies", i, "targetIntentIds"],
			"An access target",
		);
	});
	contract.navigation.forEach((nav, i) => {
		refs(
			nav.actorIds,
			["actor"],
			["navigation", i, "actorIds"],
			"A navigation intent's actor",
		);
		refs(
			nav.entryTaskIds,
			["task"],
			["navigation", i, "entryTaskIds"],
			"A navigation entry task",
		);
		refs(
			nav.readModelIds,
			["read model"],
			["navigation", i, "readModelIds"],
			"A navigation read model",
		);
		if (nav.parentNavigationId !== undefined) {
			ref(
				nav.parentNavigationId,
				["navigation intent"],
				["navigation", i, "parentNavigationId"],
				"A navigation parent",
			);
		}
	});
	contract.decisions.forEach((decision, i) => {
		evidenceRefs(decision.evidence, ["decisions", i, "evidence"]);
		/* ---- 3. selected option is local to its decision ------------- */
		if (
			!decision.options.some(
				(option) => option.id === decision.selectedOptionId,
			)
		) {
			issue(
				["decisions", i, "selectedOptionId"],
				"The selected option must be one of this decision's own options.",
			);
		}
	});
	contract.assumptions.forEach((assumption, i) => {
		evidenceRefs(assumption.evidence, ["assumptions", i, "evidence"]);
	});
	contract.openQuestions.forEach((question, i) => {
		refs(
			question.relatedIntentIds,
			RELATABLE_KINDS,
			["openQuestions", i, "relatedIntentIds"],
			"A related intent",
		);
		/* ---- 8. blocking questions name what they block -------------- */
		if (question.blocking && question.relatedIntentIds.length === 0) {
			issue(
				["openQuestions", i, "relatedIntentIds"],
				"A blocking open question must name at least one affected intent or architecture decision — otherwise nothing records what the answer would change.",
			);
		}
	});
	contract.acceptanceScenarios.forEach((scenario, i) => {
		evidenceRefs(scenario.evidence, ["acceptanceScenarios", i, "evidence"]);
		ref(
			scenario.actorId,
			["actor"],
			["acceptanceScenarios", i, "actorId"],
			"A scenario's actor",
		);
		refs(
			scenario.relatedIntentIds,
			RELATABLE_KINDS,
			["acceptanceScenarios", i, "relatedIntentIds"],
			"A scenario's related intent",
		);
		/* ---- 9. a scenario exercises the workflow -------------------- */
		const exercises = scenario.relatedIntentIds.some((id) => {
			const kind = kinds.get(id);
			return kind === "task" || kind === "transition" || kind === "read model";
		});
		if (!exercises) {
			issue(
				["acceptanceScenarios", i, "relatedIntentIds"],
				"An acceptance scenario must exercise at least one task, transition, or read model — a scenario tied to none of them proves nothing about the workflow.",
			);
		}
	});
	contract.deferredRequirements.forEach((deferred, i) => {
		ref(
			deferred.claimId,
			["source claim"],
			["deferredRequirements", i, "claimId"],
			"A deferred requirement",
		);
	});

	/* ---- 4. explicit claims are owned or deferred -------------------- */
	const deferredClaimIds = new Set(
		contract.deferredRequirements.map((d) => d.claimId),
	);
	const ownedClaimIds = new Set<string>();
	const own = (evidence: readonly string[]) => {
		for (const id of evidence) ownedClaimIds.add(id);
	};
	for (const record of contract.records) own(record.evidence);
	for (const fact of contract.facts) own(fact.evidence);
	for (const rule of contract.rules) own(rule.evidence);
	for (const task of contract.tasks) own(task.evidence);
	for (const transition of contract.transitions) own(transition.evidence);
	for (const model of contract.readModels) own(model.evidence);
	for (const policy of contract.accessPolicies) own(policy.evidence);
	contract.sourceClaims.forEach((claim, i) => {
		if (claim.status !== "explicit") return;
		if (ownedClaimIds.has(claim.id) || deferredClaimIds.has(claim.id)) return;
		issue(
			["sourceClaims", i],
			`The explicit claim "${truncate(claim.statement)}" is neither represented by an owning intent (a record, fact, rule, task, transition, read model, or access policy citing it as evidence) nor explicitly deferred. Represent it, or defer it with a reason.`,
		);
	});

	/* ---- 5. fact/task write + capture coherence ---------------------- */
	const factById = new Map<string, FactDefinition>(
		contract.facts.map((fact) => [fact.id, fact]),
	);
	const transitionById = new Map(
		contract.transitions.map((transition) => [transition.id, transition]),
	);
	const inputById = new Map(
		contract.tasks.flatMap((task) =>
			task.inputs.map((input) => [input.id, input] as const),
		),
	);
	const actualWriters = new Map<string, Set<string>>();
	const noteWriter = (factId: string, taskId: string) => {
		const set = actualWriters.get(factId);
		if (set) set.add(taskId);
		else actualWriters.set(factId, new Set([taskId]));
	};
	for (const task of contract.tasks) {
		for (const write of task.writes) noteWriter(write.targetFactId, task.id);
		for (const transitionId of task.transitionIds) {
			const transition = transitionById.get(transitionId);
			if (!transition) continue;
			for (const write of transition.writes) {
				noteWriter(write.targetFactId, task.id);
			}
		}
	}
	contract.facts.forEach((fact, i) => {
		const declared = new Set<string>(fact.writerTaskIds);
		const actual = actualWriters.get(fact.id) ?? new Set<string>();
		for (const taskId of declared) {
			if (!actual.has(taskId) && kinds.get(taskId) === "task") {
				issue(
					["facts", i, "writerTaskIds"],
					`The fact "${fact.name}" declares a writer task that carries no write intent for it — neither directly nor through a transition it triggers. Add the write intent to that task, or remove it from the writers.`,
				);
			}
		}
		for (const taskId of actual) {
			if (!declared.has(taskId)) {
				issue(
					["facts", i, "writerTaskIds"],
					`The fact "${fact.name}" is written by a task (directly or through one of its transitions) that is missing from its writer list. Declare the writer so read/write coherence stays provable.`,
				);
			}
		}
		if (fact.source.kind === "answer") {
			const input = inputById.get(fact.source.taskInputId);
			if (input && input.factId !== fact.id) {
				issue(
					["facts", i, "source", "taskInputId"],
					`The fact "${fact.name}" says its value comes from an answer, but that task input persists to a different fact. Point the two at each other.`,
				);
			}
		}
	});
	contract.tasks.forEach((task, i) => {
		task.inputs.forEach((input, j) => {
			if (input.factId === undefined) return;
			const fact = factById.get(input.factId);
			if (!fact) return; /* unresolved — already reported */
			if (
				fact.source.kind !== "answer" ||
				fact.source.taskInputId !== input.id
			) {
				issue(
					["tasks", i, "inputs", j, "factId"],
					`The input "${input.name}" claims to capture the fact "${fact.name}", but that fact's declared source is not this answer. Either make the fact answer-sourced from this input, or drop the input's fact binding.`,
				);
			}
		});
	});

	/* ---- 6. transition writes stay on the target record -------------- */
	contract.transitions.forEach((transition, i) => {
		transition.writes.forEach((write, j) => {
			const fact = factById.get(write.targetFactId);
			if (!fact) return; /* unresolved — already reported */
			if (fact.recordId !== transition.targetRecordId) {
				issue(
					["transitions", i, "writes", j, "targetFactId"],
					`The transition "${transition.name}" writes the fact "${fact.name}", which belongs to a different record than the transition's target. A transition changes exactly its target record — move the write to the right transition, or retarget the fact.`,
				);
			}
		});
	});

	/* ---- 7. acyclic parent graphs ------------------------------------ */
	reportCycles(
		contract.records.map((record) => ({
			id: record.id,
			parentId: record.parentRecordId,
			name: record.name,
		})),
		"records",
		"parentRecordId",
		"record",
		issue,
	);
	reportCycles(
		contract.navigation.map((nav) => ({
			id: nav.id,
			parentId: nav.parentNavigationId,
			name: nav.name,
		})),
		"navigation",
		"parentNavigationId",
		"navigation intent",
		issue,
	);
}

function formatKinds(kinds: readonly DesignKind[]): string {
	if (kinds.length === 1) return kinds[0] as string;
	return `${kinds.slice(0, -1).join(", ")} or ${kinds[kinds.length - 1]}`;
}

function truncate(statement: string): string {
	return statement.length > 80 ? `${statement.slice(0, 77)}…` : statement;
}

/** Walk each node's parent chain; a node that re-enters the chain under
 *  construction is a cycle. Parent ids that point outside the collection are
 *  reference errors reported elsewhere — the walk just stops there. */
function reportCycles(
	nodes: Array<{ id: string; parentId: string | undefined; name: string }>,
	collection: string,
	parentField: string,
	kind: string,
	issue: (path: IssuePath, message: string) => void,
): void {
	const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
	const settled = new Set<string>();
	nodes.forEach((node, i) => {
		if (settled.has(node.id)) return;
		const chain = new Set<string>();
		let current: string | undefined = node.id;
		while (current !== undefined && !settled.has(current)) {
			if (chain.has(current)) {
				issue(
					[collection, i, parentField],
					`The ${kind} "${node.name}" has a parent chain that never terminates — it loops back into itself. Parent relationships must form a forest; break the loop.`,
				);
				break;
			}
			chain.add(current);
			current = parentById.get(current);
		}
		for (const id of chain) settled.add(id);
	});
}
