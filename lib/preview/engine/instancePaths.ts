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

export type InstancePathProjection =
	| { readonly kind: "mapped"; readonly path: string }
	| { readonly kind: "removed" }
	| { readonly kind: "invalid"; readonly reason: string };

export interface PathSegmentIdentityMap {
	/**
	 * Stable authored identities for each old/new template segment, including
	 * the leading data-root sentinel. The arrays let a cross-parent move
	 * distinguish a retained repeat ancestor from one that was inserted or
	 * removed even when the two template paths have different depths.
	 */
	readonly oldSegmentKeys: readonly string[];
	readonly newSegmentKeys: readonly string[];
}

function parseSegments(path: string): PathSegment[] | undefined {
	if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
		return undefined;
	}
	const segments: PathSegment[] = [];
	for (const raw of path.split("/").slice(1)) {
		const parsed = /^([^[\]/]+)(?:\[(\d+)\])?$/.exec(raw);
		if (parsed === null || parsed[1] === undefined) return undefined;
		const index =
			parsed[2] === undefined ? undefined : Number.parseInt(parsed[2], 10);
		if (index !== undefined && !Number.isSafeInteger(index)) return undefined;
		segments.push({
			name: parsed[1],
			...(index === undefined ? {} : { index }),
		});
	}
	return segments.length === 0 ? undefined : segments;
}

function validSegmentKeys(
	keys: readonly string[],
	expectedLength: number,
): boolean {
	return (
		keys.length === expectedLength &&
		keys[0] === "$data" &&
		keys.every((key) => typeof key === "string" && key.length > 0) &&
		new Set(keys).size === keys.length
	);
}

/**
 * Project one concrete instance path from an old template path onto a new one.
 *
 * The result is deliberately explicit. A caller that owns bytes or another
 * destructive resource must distinguish:
 *
 * - `mapped`: the stable instance has a concrete home in the new topology;
 * - `removed`: a repeat instance above index zero legitimately has no home
 *   after its stable repeat ancestor disappears; and
 * - `invalid`: the event/path/identity projection is malformed or mismatched.
 *
 * Treating both latter states as `null` is unsafe at a destructive boundary:
 * an invalid migration event must preserve ownership and fail closed, while a
 * legitimately removed repeat instance may be retired.
 *
 * Bracket-shape changes at a segment encode a group⇄repeat conversion:
 * a segment gaining a bracket (group→repeat) takes the new template's own
 * index, and a segment losing its bracket (repeat→group) keeps only
 * instance 0. Names come from the new template and repeat indices follow
 * stable authored segment identity when supplied, so arbitrary cross-parent
 * moves do not accidentally transfer an unrelated repeat ancestor's index.
 */
export function projectInstancePath(
	concrete: string,
	oldTemplate: string,
	newTemplate: string,
	identity?: PathSegmentIdentityMap,
): InstancePathProjection {
	const c = parseSegments(concrete);
	const o = parseSegments(oldTemplate);
	const n = parseSegments(newTemplate);
	if (c === undefined || o === undefined || n === undefined) {
		return {
			kind: "invalid",
			reason: "The capture path migration contains a malformed path.",
		};
	}
	if (
		c.length !== o.length ||
		c.some((segment, index) => segment.name !== o[index]?.name)
	) {
		return {
			kind: "invalid",
			reason:
				"The capture path does not match the migration's previous template.",
		};
	}

	if (identity !== undefined) {
		if (
			!validSegmentKeys(identity.oldSegmentKeys, o.length) ||
			!validSegmentKeys(identity.newSegmentKeys, n.length)
		) {
			return {
				kind: "invalid",
				reason:
					"The capture path migration is missing a valid stable segment identity.",
			};
		}

		const oldRepeatIndices = new Map<string, number>();
		for (let i = 0; i < o.length; i++) {
			if (o[i].index !== undefined) {
				oldRepeatIndices.set(
					identity.oldSegmentKeys[i],
					c[i].index ?? o[i].index ?? 0,
				);
			}
		}
		const newRepeatKeys = new Set(
			n.flatMap((segment, index) =>
				segment.index === undefined ? [] : [identity.newSegmentKeys[index]],
			),
		);
		for (const [key, index] of oldRepeatIndices) {
			if (!newRepeatKeys.has(key) && index > 0) {
				return { kind: "removed" };
			}
		}

		let out = "";
		for (let i = 0; i < n.length; i++) {
			const index =
				n[i].index === undefined
					? undefined
					: (oldRepeatIndices.get(identity.newSegmentKeys[i]) ?? n[i].index);
			out += `/${n[i].name}${index !== undefined ? `[${index}]` : ""}`;
		}
		return { kind: "mapped", path: out };
	}

	if (o.length !== n.length) {
		return {
			kind: "invalid",
			reason:
				"The capture path migration changed depth without stable segment identity.",
		};
	}

	let out = "";
	for (let i = 0; i < c.length; i++) {
		const oldHasIndex = o[i].index !== undefined;
		const newHasIndex = n[i].index !== undefined;
		let index: number | undefined;
		if (oldHasIndex && newHasIndex) {
			index = c[i].index ?? 0;
		} else if (oldHasIndex && !newHasIndex) {
			if ((c[i].index ?? 0) > 0) return { kind: "removed" };
			index = undefined;
		} else if (!oldHasIndex && newHasIndex) {
			index = n[i].index;
		}
		out += `/${n[i].name}${index !== undefined ? `[${index}]` : ""}`;
	}
	return { kind: "mapped", path: out };
}

/**
 * Engine-local compatibility projection.
 *
 * Runtime values do not own external resources, so their established API may
 * continue collapsing `removed` and `invalid` to `null`. Attachment ownership
 * uses {@link projectInstancePath} directly and never makes that collapse.
 */
export function remapInstancePath(
	concrete: string,
	oldTemplate: string,
	newTemplate: string,
	identity?: PathSegmentIdentityMap,
): string | null {
	const projected = projectInstancePath(
		concrete,
		oldTemplate,
		newTemplate,
		identity,
	);
	return projected.kind === "mapped" ? projected.path : null;
}
