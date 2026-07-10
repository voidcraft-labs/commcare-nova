/**
 * Generic blueprint-node search shared by `scan-blueprints.ts`.
 *
 * The recurring pre-flight question for a validator or emitter change
 * is "which stored apps carry construct X, and where?". Blueprint docs
 * are plain JSON trees whose interesting constructs are tagged by
 * discriminant keys (`kind`, `type`, `code`, …), so two primitives
 * cover the questions asked in practice:
 *
 *   - `scanNodes` — every object node carrying ALL the given
 *     key=value pairs (an AND over primitive-valued keys), each with
 *     its path from the blueprint root.
 *   - `countKeyValues` — the census of every value a key takes, for
 *     sizing the fleet before anyone commits to a specific match.
 *
 * Matching is on primitive values only: strings compare as-is;
 * numbers and booleans compare by their canonical string form
 * (`"2"`, `"true"`). A key holding an object, array, or null never
 * matches — structural values have no stable one-line spelling to
 * type on a command line.
 */

export interface NodeMatch {
	/**
	 * Dotted path from the blueprint root, array steps in brackets —
	 * `modules.<uuid>.caseListConfig.columns[2].filter`. The root
	 * object itself is the empty path.
	 */
	readonly path: string;
	readonly node: Readonly<Record<string, unknown>>;
}

/**
 * Parse a CLI `key=value` pair. The first `=` splits; the value may
 * contain more. The throw surfaces directly as the script's error
 * output, so it spells out the repair.
 */
export function parseWherePair(pair: string): readonly [string, string] {
	const eq = pair.indexOf("=");
	if (eq <= 0) {
		throw new Error(
			`Could not read the --where pair "${pair}".\n\n` +
				`Each pair names a key and the value to match, joined by "=":\n\n` +
				`    --where kind=datetime-coerce\n\n` +
				`Matching is on primitive values only; numbers and booleans\n` +
				`compare by their canonical string form ("2", "true").`,
		);
	}
	return [pair.slice(0, eq), pair.slice(eq + 1)];
}

/** A primitive's canonical match string; `undefined` for anything structural. */
function matchableValue(value: unknown): string | undefined {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
			return String(value);
		default:
			return undefined;
	}
}

/**
 * Every object node in `root` (the root object included, at the empty
 * path) whose keys carry ALL the `where` pairs. An empty `where`
 * matches nothing — a match must be asked for, not defaulted into.
 */
export function scanNodes(
	root: unknown,
	where: ReadonlyMap<string, string>,
): NodeMatch[] {
	const matches: NodeMatch[] = [];
	if (where.size === 0) return matches;
	walk(root, "", (node, path) => {
		for (const [key, expected] of where) {
			if (matchableValue(node[key]) !== expected) return;
		}
		matches.push({ path, node });
	});
	return matches;
}

/**
 * Tally every primitive value `key` takes across the tree, keyed by
 * canonical match string.
 */
export function countKeyValues(
	root: unknown,
	key: string,
): Map<string, number> {
	const tally = new Map<string, number>();
	walk(root, "", (node) => {
		const value = matchableValue(node[key]);
		if (value !== undefined) {
			tally.set(value, (tally.get(value) ?? 0) + 1);
		}
	});
	return tally;
}

/** Depth-first visit of every non-array object node, building paths. */
function walk(
	value: unknown,
	path: string,
	visit: (node: Record<string, unknown>, path: string) => void,
): void {
	if (Array.isArray(value)) {
		value.forEach((item, i) => {
			walk(item, `${path}[${i}]`, visit);
		});
		return;
	}
	if (value !== null && typeof value === "object") {
		const node = value as Record<string, unknown>;
		visit(node, path);
		for (const [key, child] of Object.entries(node)) {
			walk(child, path === "" ? key : `${path}.${key}`, visit);
		}
	}
}
