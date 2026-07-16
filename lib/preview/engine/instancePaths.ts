/**
 * Repeat-instance path helpers.
 *
 * The engine stores runtime values at CONCRETE paths — repeat children live
 * under an indexed instance segment (`/data/orders[1]/medication_name`) —
 * while every authored reference prints index-free (`printXPath` emits
 * `#form/orders/medication_name`; the dependency extractor emits
 * `/data/orders/medication_name`). These helpers convert between the two
 * shapes: `stripIndices` generalizes a concrete path to its index-free form,
 * and `rebaseOntoContext` binds an index-free reference onto the repeat
 * instance the evaluating expression lives in.
 */

/** Generalize a concrete instance path to its index-free form:
 *  `/data/orders[1]/name` → `/data/orders/name`. */
export function stripIndices(path: string): string {
	return path.replace(/\[\d+\]/g, "");
}

/**
 * Bind an index-free reference onto the repeat instance of the evaluating
 * expression — CommCare's relative-reference semantic, where a reference
 * inside a repeat resolves against the SAME instance as the expression's
 * own node.
 *
 * The context path's indexed segments define the live bindings
 * (`/data/a[1]/b[0]/c` binds `/data/a` → `/data/a[1]` and `/data/a/b` →
 * `/data/a[1]/b[0]`); the longest binding that prefixes the reference wins.
 * References outside every bound repeat — and references that already carry
 * an explicit index — pass through unchanged.
 */
export function rebaseOntoContext(
	refPath: string,
	contextPath: string,
): string {
	if (refPath.includes("[") || !contextPath.includes("[")) return refPath;

	let generic = "";
	let concrete = "";
	let bound: { generic: string; concrete: string } | undefined;
	for (const segment of contextPath.split("/")) {
		if (!segment) continue;
		const indexed = /^(.*)\[\d+\]$/.exec(segment);
		generic += `/${indexed ? indexed[1] : segment}`;
		concrete += `/${segment}`;
		if (indexed && (refPath === generic || refPath.startsWith(`${generic}/`))) {
			bound = { generic, concrete };
		}
	}

	if (!bound) return refPath;
	return bound.concrete + refPath.slice(bound.generic.length);
}

interface PathSegment {
	name: string;
	index?: number;
}

function parseSegments(path: string): PathSegment[] {
	return path
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			const indexed = /^(.*?)\[(\d+)\]$/.exec(segment);
			return indexed
				? { name: indexed[1], index: Number.parseInt(indexed[2], 10) }
				: { name: segment };
		});
}

/**
 * Map one concrete instance path from an old template path onto a new one —
 * the rename/conversion move rule. Both templates walk the same tree
 * position, so they have identical segment counts; names come from the new
 * template, indices from the concrete path.
 *
 * Bracket-shape changes at a segment encode a group⇄repeat conversion:
 * a segment gaining a bracket (group→repeat) takes the new template's own
 * index, and a segment losing its bracket (repeat→group) keeps only
 * instance 0 — every other instance has no home in the new shape, so the
 * function returns `null` and the caller drops that path's value and state.
 */
export function remapInstancePath(
	concrete: string,
	oldTemplate: string,
	newTemplate: string,
): string | null {
	const c = parseSegments(concrete);
	const o = parseSegments(oldTemplate);
	const n = parseSegments(newTemplate);
	if (c.length !== o.length || o.length !== n.length) return null;

	let out = "";
	for (let i = 0; i < c.length; i++) {
		const oldHasIndex = o[i].index !== undefined;
		const newHasIndex = n[i].index !== undefined;
		let index: number | undefined;
		if (oldHasIndex && newHasIndex) {
			index = c[i].index ?? 0;
		} else if (oldHasIndex && !newHasIndex) {
			if ((c[i].index ?? 0) > 0) return null;
			index = undefined;
		} else if (!oldHasIndex && newHasIndex) {
			index = n[i].index;
		}
		out += `/${n[i].name}${index !== undefined ? `[${index}]` : ""}`;
	}
	return out;
}
