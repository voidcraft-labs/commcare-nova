import {
	expressionSource,
	type Field,
	type XPathPrintableDoc,
} from "@/lib/domain";
import { walkTerms } from "@/lib/domain/predicate";
import { extractPathRefs } from "../xpath/dependencies";
import type { FieldTreeNode } from "./fieldTree";
import { stripIndices } from "./instancePaths";
import { parseBareHashtags } from "./labelRefs";

type ExpressionType =
	| "relevant"
	| "calculate"
	| "required"
	| "validation"
	| "output"
	| "choices";

interface DagNode {
	path: string;
	expressions: { type: ExpressionType; expr: string }[];
}

/** Resolves a concrete repeat container path to its live instance count.
 *  The engine passes its `DataInstance.getRepeatCount` — the DAG itself
 *  stays a pure topology with no runtime state. */
export type RepeatCountResolver = (repeatPath: string) => number;

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
 * generic paths (`/data/orders/case_name`), the same shape `printXPath` /
 * `extractPathRefs` produce, so a reference inside a repeat matches its
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
	private doc: XPathPrintableDoc = { forms: {}, fields: {}, fieldOrder: {} };
	/** uuid → generic path over the tree being collected — the
	 *  resolution surface for lookup-choice filter `field` terms, which
	 *  reference by uuid rather than printed path. Rebuilt alongside the
	 *  nodes by `build` / `reportCycles`. */
	private fieldPaths = new Map<string, string>();

	/** Build the DAG from a field tree. `doc` is the surface the
	 *  tree's fields live on (the engine's input slice / the
	 *  validator's blueprint). */
	build(tree: FieldTreeNode[], doc: XPathPrintableDoc, prefix = "/data"): void {
		this.doc = doc;
		this.nodes.clear();
		this.dependedOnBy.clear();
		this.repeatPaths.clear();
		this.fieldPaths = collectFieldPaths(tree, prefix);
		this.collectExpressions(tree, prefix);
		this.detectAndBreakCycles();
		this.sortedPaths = this.topologicalSort();
	}

	/** Rebuild the DAG (e.g., after repeat add/remove). */
	rebuild(
		tree: FieldTreeNode[],
		doc: XPathPrintableDoc,
		prefix = "/data",
	): void {
		this.build(tree, doc, prefix);
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
		const visited = new Set<string>();
		const queue = [...new Set(changedPaths.map(stripIndices))];

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

		// Materialize in topological order
		const result: string[] = [];
		for (const generic of this.sortedPaths) {
			if (visited.has(generic)) {
				result.push(...this.materialize(generic, repeatCount));
			}
		}
		return result;
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

			if (f.kind === "group") {
				// Groups can have relevant — register then recurse
				this.registerExpressions(path, f);
				if (node.children) this.collectExpressions(node.children, path);
			} else if (f.kind === "repeat") {
				this.registerExpressions(path, f);
				// Repeat children register index-free — `materialize` expands
				// them over live instances at query time.
				this.repeatPaths.add(path);
				if (node.children) this.collectExpressions(node.children, path);
			} else {
				this.registerExpressions(path, f);
			}
		}
	}

	private registerExpressions(path: string, f: Field): void {
		const expressions: { type: ExpressionType; expr: string }[] = [];

		// The XPath-bearing slots (relevant/calculate/required/validate)
		// and the prose slots (label/hint) live on different Field
		// variants — `expressionSource` reads each through the union so a
		// slot a variant doesn't declare reads as `undefined`.
		const relevant = expressionSource(f, "relevant", this.doc);
		if (relevant) expressions.push({ type: "relevant", expr: relevant });
		const calculate = expressionSource(f, "calculate", this.doc);
		if (calculate) expressions.push({ type: "calculate", expr: calculate });
		const required = expressionSource(f, "required", this.doc);
		if (required && required !== "true()" && required !== "false()") {
			expressions.push({ type: "required", expr: required });
		}
		const validate = expressionSource(f, "validate", this.doc);
		if (validate) expressions.push({ type: "validation", expr: validate });

		// Collect all XPath expressions that create dependency edges
		const allDepExprs = expressions.map((e) => e.expr);

		// Scan label and hint for bare hashtag refs (#form/x, #case/x, #user/x)
		const allLabelRefs = parseBareHashtags(
			expressionSource(f, "label", this.doc) ?? "",
		).concat(parseBareHashtags(expressionSource(f, "hint", this.doc) ?? ""));
		if (allLabelRefs.length > 0) {
			expressions.push({ type: "output", expr: "" });
			for (const ref of allLabelRefs) allDepExprs.push(ref);
		}

		// A lookup-backed select's choice list is a real runtime value:
		// its filter's form-answer references are runtime dependency
		// edges (uuid-resolved — the filter AST references identity, not
		// printed paths), and the `choices` expression recomputes the
		// list on any of them changing, mirroring the device's
		// prompt-rebuild re-filter of its embedded fixture.
		if (
			(f.kind === "single_select" || f.kind === "multi_select") &&
			f.optionsSource !== undefined
		) {
			expressions.push({ type: "choices", expr: "" });
			if (f.optionsSource.filter !== undefined) {
				walkTerms(f.optionsSource.filter, (term) => {
					if (term.kind !== "field") return;
					const dependencyPath = this.fieldPaths.get(term.uuid);
					if (dependencyPath === undefined || dependencyPath === path) return;
					let deps = this.dependedOnBy.get(dependencyPath);
					if (!deps) {
						deps = new Set();
						this.dependedOnBy.set(dependencyPath, deps);
					}
					deps.add(path);
				});
			}
		}

		if (expressions.length === 0) return;

		this.nodes.set(path, { path, expressions });

		// Register dependency edges
		for (const depExpr of allDepExprs) {
			const refs = extractPathRefs(depExpr);
			for (const ref of refs) {
				if (ref === path) continue; // Self-reference doesn't create a dependency
				let deps = this.dependedOnBy.get(ref);
				if (!deps) {
					deps = new Set();
					this.dependedOnBy.set(ref, deps);
				}
				deps.add(path);
			}
		}
	}

	/**
	 * Add authoring-time-only edges for field defaults. This runs
	 * exclusively while `reportCycles` has swapped in its temporary maps —
	 * defaults apply once during initialization, so their references are
	 * cycle-proof surfaces, never runtime triggers. (Lookup-choice filter
	 * dependencies are RUNTIME edges since S07 — `registerExpressions`
	 * owns them for build and cycle proof alike.)
	 */
	private collectValidationOnlyDependencies(
		tree: readonly FieldTreeNode[],
		prefix: string,
	): void {
		const register = (dependencyPath: string, dependentPath: string): void => {
			if (dependencyPath === dependentPath) return;
			let deps = this.dependedOnBy.get(dependencyPath);
			if (!deps) {
				deps = new Set();
				this.dependedOnBy.set(dependencyPath, deps);
			}
			deps.add(dependentPath);
		};

		for (const node of tree) {
			const field = node.field;
			const path = `${prefix}/${field.id}`;
			let hasValidationDependency = false;

			const defaultValue = expressionSource(field, "default_value", this.doc);
			if (defaultValue !== undefined) {
				for (const ref of extractPathRefs(defaultValue)) {
					register(ref, path);
					hasValidationDependency = true;
				}
			}

			if (hasValidationDependency && !this.nodes.has(path)) {
				this.nodes.set(path, { path, expressions: [] });
			}
			if (node.children !== undefined) {
				this.collectValidationOnlyDependencies(node.children, path);
			}
		}
	}

	/**
	 * Report all cycles without modifying the runtime graph. Builds a temporary
	 * superset topology that adds authoring-only default edges on top of the
	 * full runtime topology (which already includes lookup-choice filter
	 * edges), then restores the instance maps before walking that snapshot.
	 * Returns an array of cycle paths (e.g. ['/data/a', '/data/b', '/data/a']).
	 */
	reportCycles(
		tree: FieldTreeNode[],
		doc: XPathPrintableDoc,
		prefix = "/data",
	): string[][] {
		this.doc = doc;
		// Build a fresh graph for cycle detection without mutating the instance
		const nodes = new Map<string, DagNode>();
		const dependedOnBy = new Map<string, Set<string>>();

		// Temporarily swap in fresh maps, collect, then swap back
		const savedNodes = this.nodes;
		const savedDeps = this.dependedOnBy;
		const savedRepeats = this.repeatPaths;
		const savedFieldPaths = this.fieldPaths;
		this.nodes = nodes;
		this.dependedOnBy = dependedOnBy;
		this.repeatPaths = new Set();
		try {
			this.fieldPaths = collectFieldPaths(tree, prefix);
			this.collectExpressions(tree, prefix);
			this.collectValidationOnlyDependencies(tree, prefix);
		} finally {
			this.nodes = savedNodes;
			this.dependedOnBy = savedDeps;
			this.repeatPaths = savedRepeats;
			this.fieldPaths = savedFieldPaths;
		}

		const WHITE = 0,
			GRAY = 1,
			BLACK = 2;
		const color = new Map<string, number>();
		const parent = new Map<string, string>();
		const cycles: string[][] = [];

		for (const path of nodes.keys()) {
			color.set(path, WHITE);
		}

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
						cycles.push(cycle);
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

		for (const [, dependents] of this.dependedOnBy) {
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
