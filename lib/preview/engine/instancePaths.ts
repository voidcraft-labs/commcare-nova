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
