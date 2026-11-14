import {
	type FormNodeProjection,
	formNodeProjection,
} from "@/lib/commcare/xpath/formNodeProjection";
import { formReads } from "@/lib/commcare/xpath/wire/formReads";
import {
	type BlueprintDoc,
	type Field,
	fieldProseTemplate,
	type Uuid,
} from "@/lib/domain";
import {
	expressionFacts,
	referencedCountResults,
	slotContext,
} from "@/lib/domain/expression/context";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	FieldExpressionSlotRef,
	FormNodeRef,
} from "@/lib/domain/expression/types";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import { expressionAt } from "@/lib/domain/expressionSource";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { planRepeatCountCarriers } from "@/lib/domain/repeatCount";
import type { FieldTreeNode } from "./fieldTree";
import type { FormExpressionRuntime } from "./formExpressionRuntime";
import { stripIndices } from "./instancePaths";

function formReadPaths(
	expression: Expression,
	projection: FormNodeProjection,
	pathOf = (node: FormNodeRef): string | undefined =>
		projection.path(node)?.toXPath(),
): string[] {
	return [
		...new Set(
			formReads(expression).flatMap(({ node }) => {
				const path = pathOf(node);
				return path === undefined ? [] : [path];
			}),
		),
	];
}

type ExpressionType =
	| "relevant"
	| "calculate"
	| "required"
	| "validation"
	| "output"
	| "choices";

export interface InitializationExpression {
	readonly path: string;
	readonly type: "calculate" | "relevant";
}

interface DagNode {
	path: string;
	expressions: {
		type: ExpressionType;
		expr: string;
		dependencies?: readonly string[];
	}[];
}

/**
 * One dependency loop found by `reportCycles`.
 *
 * `path` is the loop as generic paths with the first node repeated last
 * (`['/data/a', '/data/b', '/data/a']`). `cascade` is present when the loop
 * closes through a container's relevance cascade rather than through two
 * authored expressions: the container shows or hides on a condition that
 * depends on one of its own descendants. It names the edge so the report
 * can explain the containment, which no authored expression spells out.
 */
export interface CycleReport {
	readonly path: readonly string[];
	/** Count whose target feeds back through rows it creates. */
	readonly countFeedback?: string;
	readonly cascade?: {
		readonly container: string;
		readonly containerKind: "group" | "repeat";
		readonly descendant: string;
	};
}

/** Resolves a concrete repeat container path to its live instance count.
 *  The engine passes its `DataInstance.getRepeatCount` — the DAG itself
 *  stays a pure topology with no runtime state. */
export type RepeatCountResolver = (repeatPath: string) => number;

/** Value/relevance work and non-cascading required metadata remain separate
 * through evaluation, so a metadata refresh cannot rerun unrelated logic. */
export interface ExpressionEvaluationPaths {
	readonly values: readonly string[];
	readonly required: readonly string[];
	/** Paths whose wording, choices and validation run without their
	 * calculation or condition: Core evaluates those when it shows a question
	 * (`FormEntryPrompt`, `ItemsetBinding`, `FormDef.evaluateConstraint`),
	 * never as triggerables, so they read the current instance in every row. */
	readonly presentation?: readonly string[];
}

/** One change Core cascades from (`FormDef.java::triggerTriggerables`): every
 * triggerable the change reaches runs at the instances its own context names
 * once narrowed to the change (`FormDef.java::evaluateTriggerable`,
 * `Triggerable.java::narrowContextBy`). */
export interface CascadeChange {
	/** The concrete path that changed: an answer, or the place of a removed
	 * repeat row. A new row runs through the initialization program
	 * (`getAffectedInitialization`, `getRootedInitialization`). */
	readonly anchor: string;
}

interface AnchorStep {
	readonly name: string;
	readonly index: number | undefined;
}

/** A concrete path's steps with each repeat index, `/data/r[2]/x` →
 * `data`, `r` at 2, `x`. */
function anchorSteps(path: string): readonly AnchorStep[] {
	const steps: AnchorStep[] = [];
	for (const segment of path.split("/")) {
		if (!segment) continue;
		const open = segment.indexOf("[");
		steps.push(
			open < 0
				? { name: segment, index: undefined }
				: {
						name: segment.slice(0, open),
						index: Number(segment.slice(open + 1, -1)),
					},
		);
	}
	return steps;
}

/** The number of leading steps two index-free paths share. */
function sharedSteps(left: string, right: string): number {
	const a = left.split("/").filter(Boolean);
	const b = right.split("/").filter(Boolean);
	let shared = 0;
	while (shared < a.length && shared < b.length && a[shared] === b[shared])
		shared += 1;
	return shared;
}

/** The on-demand expression kinds (`ExpressionEvaluationPaths.presentation`). */
const ON_DEMAND = new Set<ExpressionType>(["output", "choices", "validation"]);

/** uuid → generic index-free path over a field tree. */
function collectFieldPaths(
	tree: readonly FieldTreeNode[],
	prefix: string,
): Map<string, string> {
	const fieldPaths = new Map<string, string>();
	const walk = (nodes: readonly FieldTreeNode[], parentPath: string): void => {
		for (const node of nodes) {
			const path = `${parentPath}/${node.field.id}`;
			fieldPaths.set(node.field.uuid, path);
			if (node.children) walk(node.children, path);
		}
	};
	walk(tree, prefix);
	return fieldPaths;
}

/**
 * Directed acyclic graph mapping field paths to dependent expressions.
 * When a value at path X changes, the DAG tells us which other paths
 * need their expressions re-evaluated.
 *
 * The topology is INDEX-FREE: nodes and dependency edges are keyed by
 * generic paths (`/data/orders/case_name`), the shape the runtime node
 * projection produces, so a reference inside a repeat matches its
 * sibling's node no matter which instance is live. Query methods
 * materialize generic paths back to concrete per-instance paths
 * (`/data/orders[1]/case_name`) over the live counts a
 * `RepeatCountResolver` reports — which is why repeat add/remove needs no
 * DAG bookkeeping at all.
 *
 * Walks the engine's `FieldTreeNode` rose tree (domain `Field` plus nested
 * children). The tree is built once by the engine from the normalized
 * doc's `fieldOrder` index.
 */
export class TriggerDag {
	/** Map from generic path → the DagNode for that field */
	private nodes = new Map<string, DagNode>();
	/** Map from generic dependency path → set of generic paths that depend on it */
	private dependedOnBy = new Map<string, Set<string>>();
	/** Topologically sorted evaluation order (generic paths) */
	private sortedPaths: string[] = [];
	/** Generic paths of the repeat containers — the expansion points
	 *  `materialize` fans out over. */
	private repeatPaths = new Set<string>();
	/** Doc surface the expression reads print against — AST slots
	 *  resolve identity leaves through it. Set by `build`. */
	private runtime: FormExpressionRuntime | undefined;
	/** uuid → generic path over the tree being collected — the
	 *  resolution surface for lookup-choice filter `field` terms, which
	 *  reference by uuid rather than printed path. Rebuilt alongside the
	 *  nodes by `build` / `reportCycles`. */
	private fieldPaths = new Map<string, string>();
	/** True only while `reportCycles` collects: the authoring proof draws
	 *  exactly the edges the device orders (see `registerExpressions`). */
	private cycleProof = false;
	/** The re-evaluation edges the device does NOT order, collected by
	 *  `registerExpressions` during a runtime build and added to the graph
	 *  only where they close no loop (`addSettleFreeEdges`). */
	private settleFreeEdges: Array<[dependency: string, dependent: string]> = [];
	/** Query repeats, whose condition belongs to each row: a cascade
	 * narrowed to one row evaluates that row's condition alone. */
	private queryRepeatPaths = new Set<string>();
	/** The nodes the engine writes for a query repeat's result
	 * (`registerQueryWrapper`), each with what it follows. They hold no
	 * expression, so an initialization reaches past them by these. */
	private derivedNodes = new Map<string, readonly string[]>();
	/** Per node, the level from which Core stops narrowing it to a change
	 * (`Triggerable.stopContextualizingAt`): the first level, shared with the
	 * node's own path, of a step one of its reads filters
	 * (`Triggerable.java::widenContextToAndClearPredicates`), lowered to a
	 * dominating node's (`updateStopContextualizingAtFromDominator`). Level 0
	 * is `data`. */
	private narrowStops = new Map<string, number>();
	private initializationDependencies = new Map<
		string,
		{ type: "calculate" | "relevant"; dependencies: readonly string[] }[]
	>();

	/** Build the DAG from a field tree. `doc` is the surface the
	 *  tree's fields live on (the engine's input slice / the
	 *  validator's blueprint). */
	build(
		tree: FieldTreeNode[],
		runtime: FormExpressionRuntime,
		prefix = "/data",
	): void {
		this.runtime = runtime;
		this.cycleProof = false;
		this.nodes.clear();
		this.dependedOnBy.clear();
		this.repeatPaths.clear();
		this.queryRepeatPaths.clear();
		this.derivedNodes.clear();
		this.narrowStops.clear();
		this.settleFreeEdges = [];
		this.fieldPaths = collectFieldPaths(tree, prefix);
		this.collectExpressions(tree, prefix);
		/* JavaRosa's show/hide trigger cascades to every descendant. These
		 * runtime edges make a calculation or condition that reads the hidden
		 * subtree run again when the container changes relevance, even though no
		 * descendant scalar value changed. The commit gate has already rejected
		 * any cycle this cascade would close. */
		this.collectRelevanceCascadeDependencies(tree, prefix, new Map());
		this.detectAndBreakCycles();
		this.addSettleFreeEdges();
		this.sortedPaths = this.topologicalSort();
		this.propagateNarrowStops();
		this.initializationDependencies.clear();
		for (const [path, node] of this.nodes) {
			const expressions = node.expressions.flatMap(({ type, dependencies }) =>
				type === "calculate" || type === "relevant"
					? [
							{
								type,
								dependencies: (dependencies ?? []).filter(
									(dependency) => dependency !== path,
								),
							},
						]
					: [],
			);
			this.initializationDependencies.set(path, expressions);
		}
	}

	initializationExpressions(path: string): InitializationExpression[] {
		return (this.initializationDependencies.get(stripIndices(path)) ?? []).map(
			({ type }) => ({ path, type }),
		);
	}

	/** Initialization actions trigger only the dependent calculations and
	 * relevance bindings. A label or required rule must not trigger an unrelated
	 * calculation attached to the same question. A relevance change also changes
	 * reads of its descendants, matching the ordinary cascade topology.
	 *
	 * Each changed path is the anchor of its own cascade, as a setvalue's
	 * target is (`FormDef.java::setValue` → `triggerTriggerables`), and a new
	 * row's path is the anchor of what the row's making triggers
	 * (`createNewRepeat`), so a calculation in a row runs only in the row the
	 * change names, or in every row where the change names none. */
	getAffectedInitialization(
		changedPaths: readonly string[],
		repeatCount: RepeatCountResolver,
	): InitializationExpression[] {
		const changes = changedPaths.map((anchor) => ({
			steps: anchorSteps(anchor),
			reached: this.initializationReach(stripIndices(anchor)),
		}));
		const result: InitializationExpression[] = [];
		const seen = new Set<string>();
		for (const path of this.sortedPaths) {
			for (const { type } of this.initializationDependencies.get(path) ?? []) {
				for (const change of changes) {
					if (!change.reached.get(path)?.has(type)) continue;
					for (const concrete of this.narrowed(
						path,
						repeatCount,
						change.steps,
					)) {
						const key = `${concrete}\u0000${type}`;
						if (seen.has(key)) continue;
						seen.add(key);
						result.push({ path: concrete, type });
					}
				}
			}
		}
		return result;
	}

	/** What a new row roots (`FormDef.java::createNewRepeat` →
	 * `initTriggerablesRootedBy`): every calculation and condition whose node
	 * is the row or inside it, and what they reach, in evaluation order, each
	 * narrowed to the row. */
	getRootedInitialization(
		rowPath: string,
		repeatCount: RepeatCountResolver,
	): InitializationExpression[] {
		const root = stripIndices(rowPath);
		const reached = this.initializationReach(root, [root]);
		const steps = anchorSteps(rowPath);
		const result: InitializationExpression[] = [];
		for (const path of this.sortedPaths)
			for (const { type } of this.initializationDependencies.get(path) ?? [])
				if (reached.get(path)?.has(type))
					for (const concrete of this.narrowed(path, repeatCount, steps))
						result.push({ path: concrete, type });
		return result;
	}

	/** The calculations and conditions a changed index-free path reaches (and,
	 * for a new row, what the roots hold), by node: every node one of whose
	 * calculation or condition reads a changed path, until nothing more is
	 * reached. A condition changes what its descendants read, and so does a
	 * query repeat's count, which decides which of its rows are relevant. */
	private initializationReach(
		changedPath: string,
		roots: readonly string[] = [],
	): Map<string, Set<"calculate" | "relevant">> {
		const changed = new Set([changedPath]);
		const rooted = (path: string) =>
			roots.some((root) => path === root || path.startsWith(`${root}/`));
		if (roots.length > 0)
			for (const path of [...this.fieldPaths.values(), ...this.nodes.keys()])
				if (rooted(path)) changed.add(path);
		const descendantsChanged = (path: string): void => {
			for (const descendant of this.fieldPaths.values())
				if (descendant.startsWith(`${path}/`)) changed.add(descendant);
			for (const attribute of this.rowAttributes(path)) changed.add(attribute);
		};
		const reached = new Map<string, Set<"calculate" | "relevant">>();
		for (let progress = true; progress; ) {
			progress = false;
			for (const path of this.sortedPaths) {
				if (
					!changed.has(path) &&
					this.derivedNodes.get(path)?.some((source) => changed.has(source))
				) {
					changed.add(path);
					if (this.queryRepeatPaths.has(path)) descendantsChanged(path);
					progress = true;
				}
				for (const {
					type,
					dependencies,
				} of this.initializationDependencies.get(path) ?? []) {
					if (reached.get(path)?.has(type)) continue;
					if (
						!rooted(path) &&
						!dependencies.some((dependency) => changed.has(dependency))
					)
						continue;
					const types = reached.get(path) ?? new Set();
					types.add(type);
					reached.set(path, types);
					changed.add(path);
					if (type === "relevant") descendantsChanged(path);
					progress = true;
				}
			}
		}
		return reached;
	}

	/**
	 * The work Core runs for each change, in evaluation order: everything the
	 * change triggers, each node at the instances its context names once
	 * narrowed to the change's anchor (`FormDef.java::evaluateTriggerables`
	 * evaluates the whole cascade against the one anchor,
	 * `evaluateTriggerable` → `Triggerable.java::narrowContextBy`). A node in
	 * the changed row runs in that row alone, even where it reads the change
	 * through a total outside the repeat; a node in a repeat the anchor is
	 * outside of runs in every row. Wording, choices and
	 * validation the cascade reaches run in every row
	 * (`ExpressionEvaluationPaths.presentation`).
	 */
	getCascadeWork(
		changes: readonly CascadeChange[],
		repeatCount: RepeatCountResolver,
	): ExpressionEvaluationPaths {
		const cascades = changes.map(({ anchor }) => {
			const generic = stripIndices(anchor);
			const visited = new Set<string>();
			const queue = [generic];
			// A question's wording can display its own answer without making a
			// calculation cycle; it refreshes when that answer changes.
			if (
				this.nodes
					.get(generic)
					?.expressions.some(({ type }) => type === "output")
			)
				visited.add(generic);
			for (let next = queue.shift(); next !== undefined; next = queue.shift())
				for (const dependent of [
					...(this.dependedOnBy.get(next) ?? []),
					...this.rowAttributes(next),
				])
					if (!visited.has(dependent)) {
						visited.add(dependent);
						queue.push(dependent);
					}
			// Required changes metadata, not an answer or its relevance. Core's
			// Condition.canCascade excludes ACTION_REQUIRE, so these dependents
			// refresh after the value cascade without becoming new seeds.
			const changed = new Set([generic, ...visited]);
			const required = new Set<string>();
			for (const [path, node] of this.nodes)
				if (
					node.expressions.some(
						({ type, dependencies }) =>
							type === "required" &&
							dependencies?.some((dependency) => changed.has(dependency)),
					)
				)
					required.add(path);
			return { steps: anchorSteps(anchor), visited, required };
		});
		const values = new Set<string>();
		const required = new Set<string>();
		const presentation = new Set<string>();
		for (const generic of this.sortedPaths) {
			const onDemand = this.nodes
				.get(generic)
				?.expressions.some(({ type }) => ON_DEMAND.has(type));
			for (const cascade of cascades) {
				if (cascade.visited.has(generic)) {
					for (const concrete of this.narrowed(
						generic,
						repeatCount,
						cascade.steps,
					))
						values.add(concrete);
					if (onDemand)
						for (const concrete of this.materialize(generic, repeatCount))
							presentation.add(concrete);
				}
				if (cascade.required.has(generic))
					for (const concrete of this.narrowed(
						generic,
						repeatCount,
						cascade.steps,
					))
						required.add(concrete);
			}
		}
		for (const path of values) presentation.delete(path);
		return {
			values: [...values],
			required: [...required],
			presentation: [...presentation],
		};
	}

	/** A query repeat's row attributes, which a change to its rows' relevance
	 * reaches as it reaches the rows' children
	 * (`FormDef.java::addChildrenOfElement` cascades to attributes too). They
	 * are no edges: a condition that reads them would close a loop, which the
	 * validator refuses (`reportCycles`) and the runtime graph would break. */
	private rowAttributes(path: string): readonly string[] {
		return this.queryRepeatPaths.has(path)
			? [`${path}/@id`, `${path}/@index`]
			: [];
	}

	/** What a screen shows of every node, with no calculation or condition run:
	 * each required condition, and each node's wording, choices and
	 * validation. The pass after an initialization program, which has already
	 * run every calculation and condition as Core runs them. */
	getPresentationWork(
		repeatCount: RepeatCountResolver,
	): ExpressionEvaluationPaths {
		const required: string[] = [];
		const presentation: string[] = [];
		for (const generic of this.sortedPaths) {
			const expressions = this.nodes.get(generic)?.expressions ?? [];
			const concretes = this.materialize(generic, repeatCount);
			if (expressions.some(({ type }) => type === "required"))
				required.push(...concretes);
			if (expressions.some(({ type }) => ON_DEMAND.has(type)))
				presentation.push(...concretes);
		}
		return { values: [], required, presentation };
	}

	/** A node's concrete instances once narrowed to an anchor
	 * (`Triggerable.java::narrowContextBy`): from the root, while the node's
	 * steps keep the anchor's names, a repeat step takes the anchor's index
	 * (`TreeReference.java::contextualize`), up to the node's stop level
	 * (`genericizeAfter`); every repeat step after that expands over all its
	 * rows. A query repeat's condition belongs to each row, so where the
	 * anchor names one of its rows the repeat's own node narrows to that row's
	 * path. */
	private narrowed(
		generic: string,
		repeatCount: RepeatCountResolver,
		anchor: readonly AnchorStep[],
	): string[] {
		const stop = this.narrowStops.get(generic);
		let concretes = [""];
		let genericSoFar = "";
		let level = 0;
		let following = true;
		for (const segment of generic.split("/")) {
			if (!segment) continue;
			genericSoFar += `/${segment}`;
			const step = anchor[level];
			following = following && step?.name === segment;
			const fixed =
				following && (stop === undefined || level < stop)
					? step?.index
					: undefined;
			const own = genericSoFar === generic;
			const expandsHere =
				this.repeatPaths.has(genericSoFar) &&
				(!own || (fixed !== undefined && this.queryRepeatPaths.has(generic)));
			const next: string[] = [];
			for (const base of concretes) {
				const path = `${base}/${segment}`;
				if (!expandsHere) next.push(path);
				else if (fixed !== undefined) {
					if (fixed < repeatCount(path)) next.push(`${path}[${fixed}]`);
				} else {
					const count = repeatCount(path);
					for (let i = 0; i < count; i++) next.push(`${path}[${i}]`);
				}
			}
			concretes = next;
			level += 1;
		}
		return concretes;
	}

	/** Lower each node's stop level to a dominating node's where they share
	 * at least that many steps (`Triggerable.java::
	 * updateStopContextualizingAtFromDominator`), which Core applies over every
	 * ordering edge until the order settles (`FormDef.java::buildRootNodes`). */
	private propagateNarrowStops(): void {
		for (let pass = 0; pass <= this.sortedPaths.length; pass++) {
			let changed = false;
			for (const [dominator, stop] of [...this.narrowStops]) {
				for (const dependent of this.dependedOnBy.get(dominator) ?? []) {
					const current = this.narrowStops.get(dependent);
					if (
						(current === undefined || stop < current) &&
						sharedSteps(dominator, dependent) >= stop
					) {
						this.narrowStops.set(dependent, stop);
						changed = true;
					}
				}
			}
			if (!changed) return;
		}
	}

	/** Lower a node's stop level to the first level of each filtered step one
	 * of its reads takes through the node's own path
	 * (`Triggerable.java::widenContextToAndClearPredicates`,
	 * `smallestIntersectingLevelWithPred`). */
	private recordFilteredReads(path: string, expression: Expression): void {
		const runtime = this.runtime;
		if (runtime === undefined) return;
		walkExpressionTerms(expression, (term) => {
			if (
				(term.kind !== "field" &&
					term.kind !== "form-node" &&
					term.kind !== "repeat-row") ||
				term.filters === undefined
			)
				return;
			for (const filter of term.filters) {
				const stepPath = runtime.readPath(filter.step);
				if (
					stepPath === undefined ||
					(path !== stepPath && !path.startsWith(`${stepPath}/`))
				)
					continue;
				const level = stepPath.split("/").filter(Boolean).length - 1;
				const current = this.narrowStops.get(path);
				if (current === undefined || level < current)
					this.narrowStops.set(path, level);
			}
		});
	}

	/** Record that `dependent` re-evaluates when `dependency` changes. A
	 *  field never depends on itself. */
	private addEdge(dependency: string, dependent: string): void {
		if (dependency === dependent && !this.cycleProof) return;
		let deps = this.dependedOnBy.get(dependency);
		if (!deps) {
			deps = new Set();
			this.dependedOnBy.set(dependency, deps);
		}
		deps.add(dependent);
	}

	/** Whether `to` is reachable from `from` over the current edges. */
	private reaches(from: string, to: string): boolean {
		const seen = new Set<string>([from]);
		const stack = [from];
		for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
			if (next === to) return true;
			for (const dependent of this.dependedOnBy.get(next) ?? []) {
				if (!seen.has(dependent)) {
					seen.add(dependent);
					stack.push(dependent);
				}
			}
		}
		return false;
	}

	/**
	 * Add the constraint and label/hint edges to the runtime graph, each
	 * only where it closes no loop. They run AFTER the triggerable edges
	 * have been settled, so a loop that exists only through one of them
	 * drops that edge (the preview validates on the next touch and the
	 * label re-renders on the next read) rather than a calculate or a
	 * relevance edge, which would leave the form's values wrong.
	 */
	private addSettleFreeEdges(): void {
		for (const [dependency, dependent] of this.settleFreeEdges) {
			if (this.reaches(dependent, dependency)) continue;
			this.addEdge(dependency, dependent);
		}
		this.settleFreeEdges = [];
	}

	/** Rebuild the DAG (e.g., after repeat add/remove). */
	rebuild(
		tree: FieldTreeNode[],
		runtime: FormExpressionRuntime,
		prefix = "/data",
	): void {
		this.build(tree, runtime, prefix);
	}

	/**
	 * Get all concrete paths affected by a change at `changedPath`, in
	 * evaluation order. The change path is generalized, BFS runs over the
	 * index-free dependedOnBy edges, and each affected generic node fans
	 * out to every live instance. An affected node in a repeat re-evaluates
	 * across ALL instances rather than only the changed one — each
	 * evaluation binds to its own instance's context, so the extra
	 * evaluations are no-ops that skip the store write.
	 */
	getAffected(changedPath: string, repeatCount: RepeatCountResolver): string[] {
		return this.getAffectedMany([changedPath], repeatCount);
	}

	/**
	 * Multi-seed variant of `getAffected` — one BFS over the index-free
	 * edges from every seed, one materialization pass. Callers with many
	 * seeds (repeat cardinality changes touch every leaf in the repeat)
	 * use this instead of unioning per-seed walks.
	 */
	getAffectedMany(
		changedPaths: readonly string[],
		repeatCount: RepeatCountResolver,
	): string[] {
		const paths = this.getAffectedWork(changedPaths, repeatCount);
		return [...new Set([...paths.values, ...paths.required])];
	}

	getAffectedWork(
		changedPaths: readonly string[],
		repeatCount: RepeatCountResolver,
	): ExpressionEvaluationPaths {
		const visited = new Set<string>();
		const queue = [...new Set(changedPaths.map(stripIndices))];
		// A question's wording can display its own answer without making a
		// calculation cycle. It must refresh when that answer changes even
		// though addEdge deliberately excludes self dependencies.
		for (const path of queue) {
			if (
				this.nodes.get(path)?.expressions.some(({ type }) => type === "output")
			) {
				visited.add(path);
			}
		}

		while (queue.length > 0) {
			const current = queue.shift();
			if (current === undefined) continue;
			const dependents = this.dependedOnBy.get(current);
			if (!dependents) continue;
			for (const dep of dependents) {
				if (!visited.has(dep)) {
					visited.add(dep);
					queue.push(dep);
				}
			}
		}
		// Required changes metadata, not an answer or its relevance. Core's
		// Condition.canCascade excludes ACTION_REQUIRE, so these dependents
		// refresh after the value cascade without becoming new BFS seeds.
		const changed = new Set([...changedPaths.map(stripIndices), ...visited]);
		const required = new Set<string>();
		for (const [path, node] of this.nodes) {
			if (
				node.expressions.some(
					({ type, dependencies }) =>
						type === "required" &&
						dependencies?.some((dependency) => changed.has(dependency)),
				)
			)
				required.add(path);
		}

		// Materialize in topological order
		const values: string[] = [];
		const metadata: string[] = [];
		for (const generic of this.sortedPaths) {
			if (visited.has(generic)) {
				values.push(...this.materialize(generic, repeatCount));
			}
			if (required.has(generic))
				metadata.push(...this.materialize(generic, repeatCount));
		}
		return { values, required: metadata };
	}

	/** Every node's work, as Formplayer does it on each request: it rebuilds
	 *  the form session and Core's `FormDef.initialize(false, …)` runs
	 *  `initAllTriggerables`, so every calculate, relevance, output and
	 *  choices expression re-evaluates in dependency order, and every
	 *  required condition refreshes. Defaults and start-of-form setvalues are
	 *  initialization, not triggerables, so they never run here. */
	getAllWork(repeatCount: RepeatCountResolver): ExpressionEvaluationPaths {
		const values: string[] = [];
		const required: string[] = [];
		for (const generic of this.sortedPaths) {
			const concretes = this.materialize(generic, repeatCount);
			values.push(...concretes);
			if (
				this.nodes
					.get(generic)
					?.expressions.some(({ type }) => type === "required")
			)
				required.push(...concretes);
		}
		return { values, required };
	}

	/** Expand a path (concrete or generic) to every live concrete instance
	 *  path — the public face of `materialize` for the engine's
	 *  instance-aware incremental operations. */
	materializePath(path: string, repeatCount: RepeatCountResolver): string[] {
		return this.materialize(stripIndices(path), repeatCount);
	}

	/** Get all expressions registered for a path (concrete or generic —
	 *  instance indices are stripped before the lookup). */
	getExpressions(path: string): { type: ExpressionType; expr: string }[] {
		return this.nodes.get(stripIndices(path))?.expressions ?? [];
	}

	/** Get all concrete paths that have expressions, in evaluation order —
	 *  every generic node expanded over its live instances. */
	getAllPaths(repeatCount: RepeatCountResolver): string[] {
		const result: string[] = [];
		for (const generic of this.sortedPaths) {
			result.push(...this.materialize(generic, repeatCount));
		}
		return result;
	}

	/**
	 * Expand a generic node path to every live concrete instance path. A
	 * node nested under K repeats fans out over the cartesian product of
	 * live instance indices. The repeat container's OWN node stays
	 * index-free — its FieldState (relevance, label, `repeatCount`) is one
	 * shared entry per container, matching the engine store's shape.
	 */
	private materialize(
		generic: string,
		repeatCount: RepeatCountResolver,
	): string[] {
		let concretes = [""];
		let genericSoFar = "";
		for (const segment of generic.split("/")) {
			if (!segment) continue;
			genericSoFar += `/${segment}`;
			const expandsHere =
				genericSoFar !== generic && this.repeatPaths.has(genericSoFar);
			const next: string[] = [];
			for (const base of concretes) {
				const path = `${base}/${segment}`;
				if (expandsHere) {
					const count = repeatCount(path);
					for (let i = 0; i < count; i++) next.push(`${path}[${i}]`);
				} else {
					next.push(path);
				}
			}
			concretes = next;
		}
		return concretes;
	}

	private collectExpressions(tree: FieldTreeNode[], prefix: string): void {
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;

			if (f.kind === "group" || f.kind === "section") {
				// Groups can have relevant (a section has no slots, so it
				// registers nothing) — register then recurse
				this.registerExpressions(path, f);
				if (node.children) this.collectExpressions(node.children, path);
			} else if (f.kind === "repeat") {
				this.registerExpressions(path, f);
				// Repeat children register index-free — `materialize` expands
				// them over live instances at query time.
				this.repeatPaths.add(path);
				if (f.repeat_mode === "query_bound") this.registerQueryWrapper(path);
				if (node.children) this.collectExpressions(node.children, path);
			} else {
				this.registerExpressions(path, f);
			}
		}
	}

	/** A query repeat's result, as the engine writes it on the wrapper and
	 * the rows (`FormEngine.materializeQueryResult`): the ids give the count
	 * and each row's id, the count gives each row's relevance in the count
	 * placement (its guard), and the rows give the wrapper's
	 * `@current_index`, which counts the relevant ones. The nodes hold no
	 * expression of their own; a read of any of them is an edge from it. */
	private registerQueryWrapper(path: string): void {
		this.queryRepeatPaths.add(path);
		const ids = `${path}/@ids`;
		const count = `${path}/@count`;
		const position = `${path}/@current_index`;
		const rowId = `${path}/@id`;
		for (const node of [path, ids, count, position, rowId])
			if (!this.nodes.has(node))
				this.nodes.set(node, { path: node, expressions: [] });
		const follows: ReadonlyArray<readonly [string, readonly string[]]> = [
			[count, [ids]],
			[rowId, [ids, count]],
			[path, [count]],
			[position, [path]],
		];
		for (const [node, sources] of follows) {
			this.derivedNodes.set(node, sources);
			for (const source of sources) this.addEdge(source, node);
		}
	}

	private registerExpressions(path: string, field: Field): void {
		const runtime = this.runtime;
		if (runtime === undefined)
			throw new Error("The form dependency graph has no expression runtime.");
		const expressions: DagNode["expressions"] = [];
		const add = (
			slot: FieldExpressionSlotRef["slot"],
			type: ExpressionType,
			edge: "trigger" | "settle-free" | "metadata",
		): void => {
			const ref = { entity: "field", uuid: field.uuid, slot } as const;
			const expression = expressionAt(runtime.doc, ref);
			if (expression === undefined) return;
			const dependencies = formReadPaths(
				expression,
				runtime.projection,
				runtime.readPath,
			);
			if (edge === "trigger") this.recordFilteredReads(path, expression);
			expressions.push({
				type,
				expr: runtime.lower(expression, ref),
				dependencies,
			});
			for (const dependency of dependencies) {
				if (edge === "trigger") this.addEdge(dependency, path);
				else if (edge === "settle-free" && dependency !== path)
					this.settleFreeEdges.push([dependency, path]);
			}
		};
		add("relevant", "relevant", "trigger");
		add("calculate", "calculate", "trigger");
		add("required", "required", "metadata");
		add("validate", "validation", "settle-free");
		const templates = (["label", "hint", "help", "validate_msg"] as const).map(
			(slot) => fieldProseTemplate(field, slot),
		);
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind === "inline"
		)
			templates.push(
				...field.optionsSource.options.map((option) => option.label),
			);
		const wording = templates.flatMap(
			(template) =>
				template?.parts.filter((part) => part.kind !== "text") ?? [],
		);
		if (wording.length > 0) {
			expressions.push({ type: "output", expr: "" });
			for (const part of wording) {
				// A calculated value redraws its text when anything it reads
				// changes, as a reference does when its answer does.
				if (part.kind === "value") {
					for (const dependency of formReadPaths(
						part.expression,
						runtime.projection,
						runtime.readPath,
					))
						if (dependency !== path)
							this.settleFreeEdges.push([dependency, path]);
					continue;
				}
				if (part.kind !== "field-ref") continue;
				const dependency = this.fieldPaths.get(part.uuid);
				if (dependency !== undefined && dependency !== path)
					this.settleFreeEdges.push([dependency, path]);
			}
		}
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind !== "inline"
		) {
			expressions.push({ type: "choices", expr: "" });
			if (field.optionsSource.filter !== undefined)
				for (const dependency of formReadPaths(
					field.optionsSource.filter,
					runtime.projection,
					runtime.readPath,
				))
					this.addEdge(dependency, path);
		}
		if (expressions.length > 0) this.nodes.set(path, { path, expressions });
	}

	/**
	 * Add the edges JavaRosa draws from a container's
	 * relevance to everything inside it. This runs exclusively while
	 * `reportCycles` has swapped in its temporary maps.
	 *
	 * On the device a group's or repeat's `relevant` condition cascades to its
	 * descendants (`commcare-core .../model/condition/Condition.java::
	 * isCascadingToChildren` is true for the show/hide actions), so when
	 * `FormDef.java::finalizeTriggerables` orders the form's conditions,
	 * `fillTriggeredElements` expands the container's target to the container
	 * PLUS every descendant (`findCascadeReferences`) and makes every
	 * condition that reads any of those nodes depend on the container's
	 * condition. A container whose own condition reads one of its descendants
	 * therefore depends on itself, and `throwGraphCyclesException` rejects the
	 * form as "Logic is cyclical" at install (`XFormParser.java` runs the same
	 * check at parse). CommCare HQ runs that parse to validate a build, which
	 * is where an app passing only the authored-expression edges used to be
	 * refused. Here the same fact is one edge per (container, descendant)
	 * pair: a change to the container re-triggers its descendants, so any
	 * path from a descendant back to the container's condition is a loop. A
	 * `section` has no `relevant` slot and never cascades.
	 *
	 * Runtime uses the same cascade because effective visibility changes the
	 * nodeset a descendant path selects even when every descendant scalar is
	 * unchanged. `reportCycles` additionally records which of these edges
	 * closed a loop so the authoring finding can explain the containment.
	 */
	private collectRelevanceCascadeDependencies(
		tree: readonly FieldTreeNode[],
		prefix: string,
		cascadeEdges: Map<string, CycleReport["cascade"]>,
	): void {
		const descendantPaths = (
			nodes: readonly FieldTreeNode[],
			parentPath: string,
			out: string[],
		): void => {
			for (const node of nodes) {
				const path = `${parentPath}/${node.field.id}`;
				out.push(path);
				if (node.children) descendantPaths(node.children, path, out);
			}
		};

		for (const node of tree) {
			const field = node.field;
			const path = `${prefix}/${field.id}`;
			if (node.children === undefined) continue;
			const containerKind =
				field.kind === "group" || field.kind === "repeat"
					? field.kind
					: undefined;
			// A query repeat's row is relevant only within its result in the
			// count placement (the guard on `item`), so its rows' relevance can
			// change with no authored condition.
			const hasRelevant =
				(this.nodes.get(path)?.expressions.some((e) => e.type === "relevant") ??
					false) ||
				(this.queryRepeatPaths.has(path) &&
					this.runtime !== undefined &&
					field.kind === "repeat" &&
					this.countPlaced(field.uuid));
			if (containerKind !== undefined && hasRelevant) {
				const descendants: string[] = [];
				descendantPaths(node.children, path, descendants);
				for (const descendant of descendants) {
					this.addEdge(path, descendant);
					cascadeEdges.set(`${path}\u0000${descendant}`, {
						container: path,
						containerKind,
						descendant,
					});
				}
			}
			this.collectRelevanceCascadeDependencies(
				node.children,
				path,
				cascadeEdges,
			);
		}
	}

	/** Whether a query repeat takes the count placement in the runtime's
	 * form. */
	private countPlaced(uuid: Uuid): boolean {
		const runtime = this.runtime;
		if (runtime === undefined) return false;
		const form = formStructure(runtime.doc, runtime.formUuid);
		return (
			form !== undefined &&
			effectiveQueryRepeatPlacement(form, uuid) === "count"
		);
	}

	/** Collect the finite native trigger graph directly from stored identities.
	 * Generated calculate targets participate exactly like authored questions. */
	private collectNativeDependencies(
		doc: BlueprintDoc,
		formUuid: Uuid,
		countFeedback: boolean,
		cascadeEdges: Map<string, CycleReport["cascade"]>,
		countEdges: Map<string, string>,
	): void {
		const form = formStructure(doc, formUuid);
		if (form === undefined) return;
		const projection = formNodeProjection(doc, form, { surface: "wire" });
		const counts = planRepeatCountCarriers(
			form,
			referencedCountResults(doc, formUuid),
			expressionFacts(doc),
		);
		// Candidate documents can still contain invalid field names. Cycle
		// diagnostics need labels for their identities, not executable FormPaths;
		// the field validator reports the invalid names independently.
		const pathOf = (node: FormNodeRef): string | undefined => {
			const coordinates = projection.graph.path(node);
			if (coordinates === undefined) return undefined;
			let label = "";
			for (const coordinate of coordinates) {
				const step = projection.step(coordinate);
				if (step === undefined) return undefined;
				label += `/${step.attribute ? "@" : ""}${step.name}`;
			}
			return label;
		};
		const ensure = (path: string) => {
			if (!this.nodes.has(path))
				this.nodes.set(path, { path, expressions: [] });
		};
		const add = (
			expression: Expression,
			target: FormNodeRef,
			type: "relevant" | "calculate",
			allowSelf = true,
		) => {
			const path = pathOf(target);
			if (path === undefined) return;
			ensure(path);
			this.nodes.get(path)?.expressions.push({ type, expr: "" });
			for (const dependency of formReadPaths(expression, projection, pathOf)) {
				if (allowSelf || dependency !== path) this.addEdge(dependency, path);
			}
		};
		for (const [uuid, field] of form.fields) {
			const row: FormNodeRef = { kind: "field", uuid };
			const rowPath = pathOf(row);
			if (rowPath === undefined) continue;
			this.fieldPaths.set(uuid, rowPath);
			for (const { ref, expression } of expressionSlotValues(doc, {
				entity: "field",
				uuid,
			})) {
				if (ref.entity !== "field") continue;
				// Required is a triggerable, but cannot cascade: its result
				// changes only metadata. It cannot close a native value cycle.
				if (ref.slot === "relevant" || ref.slot === "calculate") {
					const target = slotContext(doc, ref, new Map(), { form })?.sourceNode;
					if (target !== undefined) add(expression, target, ref.slot);
				} else if (!countFeedback && ref.slot === "default_value")
					add(expression, row, "calculate", false);
				else if (ref.slot === "lookup_options_source")
					add(expression, row, "calculate", false);
			}
			if (field.kind === "repeat" && field.repeatMode === "query_bound") {
				const ids = pathOf({ kind: "repeat", repeat: uuid, role: "query-ids" });
				const count = pathOf({
					kind: "repeat",
					repeat: uuid,
					role: "query-count",
				});
				const position = pathOf({
					kind: "repeat",
					repeat: uuid,
					role: "query-position",
				});
				if (count !== undefined && ids !== undefined) {
					ensure(count);
					this.addEdge(ids, count);
				}
				if (position !== undefined) {
					ensure(position);
					this.addEdge(rowPath, position);
				}
				// The count placement computes its result with calculates: the
				// ids from the query, the count from the ids, each row's id from
				// both, and each row's relevance guard from the count. A query
				// that reads answers inside its own rows therefore closes a
				// loop through the guard's cascade. Model iteration sets its
				// result once, at `xforms-ready`, and has none of these edges.
				if (effectiveQueryRepeatPlacement(form, uuid) === "count") {
					const query = form.expressionAt({
						entity: "field",
						uuid,
						slot: "ids_query",
					});
					const rowId = pathOf({
						kind: "repeat-row",
						repeat: uuid,
						attribute: "id",
					});
					if (ids !== undefined) {
						ensure(ids);
						if (query !== undefined)
							for (const dependency of formReadPaths(query, projection, pathOf))
								this.addEdge(dependency, ids);
						if (rowId !== undefined) this.addEdge(ids, rowId);
					}
					if (rowId !== undefined) ensure(rowId);
					if (count !== undefined) {
						ensure(rowPath);
						this.addEdge(count, rowPath);
						if (rowId !== undefined) this.addEdge(count, rowId);
						const descend = (node: FormNodeRef): void => {
							for (const child of projection.graph.children(node)) {
								const descendant = pathOf(child);
								if (descendant !== undefined) {
									this.addEdge(rowPath, descendant);
									cascadeEdges.set(`${rowPath}\u0000${descendant}`, {
										container: rowPath,
										containerKind: "repeat",
										descendant,
									});
								}
								descend(child);
							}
						};
						descend(row);
					}
				}
			}
			if (
				field.kind === "repeat" &&
				field.repeatMode === "count_bound" &&
				form.expressionAt({ entity: "field", uuid, slot: "repeat_count" }) !==
					undefined
			) {
				const count = counts.forRepeat(uuid);
				if (count?.materialized)
					add(
						count.expression,
						{ kind: "repeat", repeat: uuid, role: "count-result" },
						"calculate",
					);
				if (countFeedback && count !== undefined) {
					ensure(rowPath);
					for (const dependency of formReadPaths(
						count.expression,
						projection,
						pathOf,
					)) {
						this.addEdge(dependency, rowPath);
						countEdges.set(`${dependency}\u0000${rowPath}`, rowPath);
					}
				}
			}
			if (field.kind === "repeat" && countFeedback) {
				ensure(rowPath);
				const descend = (node: FormNodeRef): void => {
					for (const child of projection.graph.children(node)) {
						const descendant = pathOf(child);
						if (descendant !== undefined) this.addEdge(rowPath, descendant);
						descend(child);
					}
				};
				descend(row);
			}
		}
		for (const { ref, expression } of expressionSlotValues(doc, {
			entity: "form",
			uuid: formUuid,
		})) {
			if (
				ref.slot !== "assessment_user_score" &&
				ref.slot !== "deliver_entity_id" &&
				ref.slot !== "deliver_entity_name"
			)
				continue;
			const target = slotContext(doc, ref, new Map(), { form })?.sourceNode;
			if (target !== undefined) add(expression, target, "calculate");
		}
		for (const [uuid, field] of form.fields) {
			if (field.kind !== "group" && field.kind !== "repeat") continue;
			const ref = { entity: "field", uuid, slot: "relevant" } as const;
			if (expressionAt(doc, ref) === undefined) continue;
			const target = slotContext(doc, ref, new Map(), { form })?.sourceNode;
			const container = target === undefined ? undefined : pathOf(target);
			if (target === undefined || container === undefined) continue;
			const descend = (node: FormNodeRef): void => {
				for (const child of projection.graph.children(node)) {
					const descendant = pathOf(child);
					if (descendant !== undefined) {
						this.addEdge(container, descendant);
						cascadeEdges.set(`${container}\u0000${descendant}`, {
							container,
							containerKind: field.kind as "group" | "repeat",
							descendant,
						});
					}
					descend(child);
				}
			};
			descend(target);
		}
	}

	/**
	 * Report all cycles without modifying the runtime graph. Builds a
	 * temporary topology holding the edges the device orders, plus count
	 * cardinality feedback (which parses but can make entry unfinishable): the
	 * cascading triggerable edges (relevant / calculate, plus the
	 * lookup-choice filter edges), the authoring-only field-default edges, and
	 * the relevance cascade that runtime also uses from a container to its
	 * descendants. It excludes required metadata and the constraint or label
	 * edges the runtime keeps only for re-evaluation (see `registerExpressions`). Restores the instance
	 * maps before walking that snapshot. Returns one `CycleReport` per loop.
	 */
	reportCycles(
		tree: FieldTreeNode[],
		doc: BlueprintDoc,
		formUuid: Uuid,
		prefix = "/data",
	): CycleReport[] {
		return [
			...this.reportGraphCycles(tree, doc, formUuid, prefix, false),
			...this.reportGraphCycles(tree, doc, formUuid, prefix, true).filter(
				(cycle) => cycle.countFeedback !== undefined,
			),
		];
	}

	private reportGraphCycles(
		_tree: FieldTreeNode[],
		doc: BlueprintDoc,
		formUuid: Uuid,
		_prefix: string,
		countFeedback: boolean,
	): CycleReport[] {
		// Build a fresh graph for cycle detection without mutating the instance
		const nodes = new Map<string, DagNode>();
		const dependedOnBy = new Map<string, Set<string>>();
		const cascadeEdges = new Map<string, CycleReport["cascade"]>();
		const countEdges = new Map<string, string>();

		// Temporarily swap in fresh maps, collect, then swap back
		const savedNodes = this.nodes;
		const savedDeps = this.dependedOnBy;
		const savedRepeats = this.repeatPaths;
		const savedFieldPaths = this.fieldPaths;
		const savedCycleProof = this.cycleProof;
		this.nodes = nodes;
		this.dependedOnBy = dependedOnBy;
		this.repeatPaths = new Set();
		try {
			this.cycleProof = true;
			this.fieldPaths = new Map();
			this.collectNativeDependencies(
				doc,
				formUuid,
				countFeedback,
				cascadeEdges,
				countEdges,
			);
		} finally {
			this.nodes = savedNodes;
			this.dependedOnBy = savedDeps;
			this.repeatPaths = savedRepeats;
			this.fieldPaths = savedFieldPaths;
			this.cycleProof = savedCycleProof;
		}

		const WHITE = 0,
			GRAY = 1,
			BLACK = 2;
		const color = new Map<string, number>();
		const parent = new Map<string, string>();
		const cycles: CycleReport[] = [];

		for (const path of nodes.keys()) {
			color.set(path, WHITE);
		}

		const report = (cycle: readonly string[]): CycleReport => {
			for (let i = 0; i + 1 < cycle.length; i++) {
				const countFeedback = countEdges.get(
					`${cycle[i]}\u0000${cycle[i + 1]}`,
				);
				if (countFeedback !== undefined) return { path: cycle, countFeedback };
			}
			for (let i = 0; i + 1 < cycle.length; i++) {
				const cascade = cascadeEdges.get(`${cycle[i]}\u0000${cycle[i + 1]}`);
				if (cascade !== undefined) return { path: cycle, cascade };
			}
			return { path: cycle };
		};

		const dfs = (u: string): void => {
			color.set(u, GRAY);
			const dependents = dependedOnBy.get(u);
			if (dependents) {
				for (const v of dependents) {
					const c = color.get(v) ?? WHITE;
					if (c === GRAY) {
						// Back edge — reconstruct cycle
						const cycle = [v, u];
						let cur = u;
						while (cur !== v) {
							const next = parent.get(cur);
							if (next === undefined) break;
							cur = next;
							cycle.push(cur);
						}
						cycle.reverse();
						cycles.push(report(cycle));
					} else if (c === WHITE) {
						parent.set(v, u);
						dfs(v);
					}
				}
			}
			color.set(u, BLACK);
		};

		for (const path of nodes.keys()) {
			if ((color.get(path) ?? WHITE) === WHITE) {
				dfs(path);
			}
		}

		return cycles;
	}

	/** DFS cycle detection. If a cycle is found, break it by removing the back-edge. */
	private detectAndBreakCycles(): void {
		const WHITE = 0,
			GRAY = 1,
			BLACK = 2;
		const color = new Map<string, number>();

		for (const path of this.nodes.keys()) {
			color.set(path, WHITE);
		}

		const dfs = (u: string): void => {
			color.set(u, GRAY);
			const dependents = this.dependedOnBy.get(u);
			if (dependents) {
				for (const v of dependents) {
					const c = color.get(v) ?? WHITE;
					if (c === GRAY) {
						// Back edge found — break it
						console.warn(
							`[Preview] Cycle detected: ${u} → ${v}. Breaking edge.`,
						);
						dependents.delete(v);
					} else if (c === WHITE) {
						dfs(v);
					}
				}
			}
			color.set(u, BLACK);
		};

		for (const path of this.nodes.keys()) {
			if ((color.get(path) ?? WHITE) === WHITE) {
				dfs(path);
			}
		}
	}

	/** Kahn's algorithm for topological sort. */
	private topologicalSort(): string[] {
		// Build in-degree counts for nodes that have expressions
		const inDegree = new Map<string, number>();
		for (const path of this.nodes.keys()) {
			if (!inDegree.has(path)) inDegree.set(path, 0);
		}

		// An edge from a path with no expression (an answer) orders nothing:
		// that path is never dequeued, so counting it would leave its
		// dependents out of the order.
		for (const [source, dependents] of this.dependedOnBy) {
			if (!this.nodes.has(source)) continue;
			for (const dep of dependents) {
				if (this.nodes.has(dep)) {
					inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
				}
			}
		}

		const queue: string[] = [];
		for (const [path, deg] of inDegree) {
			if (deg === 0) queue.push(path);
		}

		const sorted: string[] = [];
		while (queue.length > 0) {
			const current = queue.shift();
			if (current === undefined) continue;
			sorted.push(current);

			const dependents = this.dependedOnBy.get(current);
			if (dependents) {
				for (const dep of dependents) {
					if (!this.nodes.has(dep)) continue;
					const newDeg = (inDegree.get(dep) ?? 1) - 1;
					inDegree.set(dep, newDeg);
					if (newDeg === 0) queue.push(dep);
				}
			}
		}

		// Add any remaining nodes that weren't reachable (islands)
		for (const path of this.nodes.keys()) {
			if (!sorted.includes(path)) sorted.push(path);
		}

		return sorted;
	}
}
