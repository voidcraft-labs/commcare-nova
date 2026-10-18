/**
 * The pre-expression-cutover XPath projection, frozen from
 * `lib/domain/xpath/print.ts` at 3b301045 (unchanged from 5cf6e327).
 *
 * The cutover prints old stored parts against their raw document before the
 * production expression parser lifts them. These structural types and the
 * three identity lookups deliberately import no old schema: PR5 removes
 * `lib/domain/xpath`, while this reader lives until the cutover's removal.
 * A missing identity stays an explicit unsuccessful projection so the lift
 * can report `old-reference-dangling`, never parse a repair marker as text.
 */

export type FrozenXPathPart =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "field-ref"; readonly uuid: string }
	| { readonly kind: "path-ref"; readonly uuid: string }
	| {
			readonly kind: "case-ref";
			readonly caseType: string;
			readonly property: string;
	  }
	| { readonly kind: "user-ref"; readonly property: string }
	| {
			readonly kind: "user-property-ref";
			readonly userPropertyUuid: string;
	  }
	| {
			readonly kind: "search-answer-ref";
			readonly searchInputUuid: string;
	  };

export interface FrozenXPathExpression {
	readonly parts: readonly FrozenXPathPart[];
}

/** The raw document's records and order arrays, with no schema dependency. */
export interface FrozenXPathPrintableDoc {
	readonly fields: Readonly<Record<string, unknown>>;
	readonly forms: Readonly<Record<string, unknown>>;
	readonly fieldOrder: Readonly<Record<string, readonly string[] | undefined>>;
	readonly userProperties?: Readonly<Record<string, unknown>>;
	readonly modules?: Readonly<Record<string, unknown>>;
	/** Raw carriers omit this; retained for parity with the pre-step printer. */
	readonly fieldParent?: Readonly<Record<string, string | null | undefined>>;
}

export interface FrozenXPathPrintContext {
	fieldPathSegments(uuid: string): readonly string[] | undefined;
	userPropertySlug(uuid: string): string | undefined;
	searchInputName(uuid: string): string | undefined;
}

export interface FrozenUnresolvedXPathProjection {
	readonly kind:
		| "field-ref"
		| "path-ref"
		| "user-property-ref"
		| "search-answer-ref";
	readonly identity: string;
}

export type FrozenXPathProjectionResult =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly text: string;
			readonly unresolved: readonly FrozenUnresolvedXPathProjection[];
	  };

/** Raw JSON members never resolve through an object's prototype. */
function ownValue<T>(
	record: Readonly<Record<string, T>> | undefined,
	key: string,
): T | undefined {
	return record !== undefined && Object.hasOwn(record, key)
		? record[key]
		: undefined;
}

function rawMember(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return ownValue(value as Readonly<Record<string, unknown>>, key);
}

/** Resolve the old leaves against the raw rows' current names and topology. */
export function frozenXPathPrintContext(
	doc: FrozenXPathPrintableDoc,
): FrozenXPathPrintContext {
	let derivedParents: Record<string, string> | undefined;
	const parentOf = (uuid: string): string | undefined => {
		const maintained = ownValue(doc.fieldParent, uuid);
		if (typeof maintained === "string") return maintained;
		if (doc.fieldParent !== undefined && maintained !== undefined) {
			return undefined;
		}
		if (derivedParents === undefined) {
			derivedParents = Object.create(null) as Record<string, string>;
			for (const [parent, children] of Object.entries(doc.fieldOrder)) {
				for (const child of children ?? []) derivedParents[child] = parent;
			}
		}
		return ownValue(derivedParents, uuid);
	};

	const cache = new Map<string, readonly string[] | undefined>();
	return {
		fieldPathSegments(uuid) {
			const cached = cache.get(uuid);
			if (cached !== undefined || cache.has(uuid)) return cached;
			const segments: string[] = [];
			let result: readonly string[] | undefined;
			let cursor: string | undefined = uuid;
			const seen = new Set<string>();
			while (cursor !== undefined && !seen.has(cursor)) {
				const id = rawMember(ownValue(doc.fields, cursor), "id");
				if (typeof id !== "string") break;
				seen.add(cursor);
				segments.unshift(id);
				const parent = parentOf(cursor);
				if (parent !== undefined && ownValue(doc.forms, parent) !== undefined) {
					result = segments;
					break;
				}
				cursor = parent;
			}
			cache.set(uuid, result);
			return result;
		},
		userPropertySlug(uuid) {
			const slug = rawMember(ownValue(doc.userProperties, uuid), "slug");
			return typeof slug === "string" ? slug : undefined;
		},
		searchInputName(uuid) {
			for (const mod of Object.values(doc.modules ?? {})) {
				const inputs = rawMember(
					rawMember(mod, "caseListConfig"),
					"searchInputs",
				);
				if (!Array.isArray(inputs)) continue;
				const input = inputs.find(
					(candidate) => rawMember(candidate, "uuid") === uuid,
				);
				if (input !== undefined) {
					const name = rawMember(input, "name");
					return typeof name === "string" ? name : undefined;
				}
			}
			return undefined;
		},
	};
}

/** Text stays verbatim; identity leaves use the pre-step canonical spelling. */
export function projectFrozenXPath(
	expr: FrozenXPathExpression,
	ctx: FrozenXPathPrintContext,
): FrozenXPathProjectionResult {
	let out = "";
	const unresolved: FrozenUnresolvedXPathProjection[] = [];
	for (const part of expr.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref": {
				const segments = ctx.fieldPathSegments(part.uuid);
				if (segments === undefined) {
					unresolved.push({ kind: part.kind, identity: part.uuid });
					out += "#form/[reference needs repair]";
				} else {
					out += `#form/${segments.join("/")}`;
				}
				break;
			}
			case "path-ref": {
				const path = ctx.fieldPathSegments(part.uuid);
				if (path === undefined) {
					unresolved.push({ kind: part.kind, identity: part.uuid });
					out += "/data/[reference needs repair]";
				} else {
					out += `/data/${path.join("/")}`;
				}
				break;
			}
			case "case-ref":
				out += `#${part.caseType}/${part.property}`;
				break;
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			case "user-property-ref": {
				const slug = ctx.userPropertySlug(part.userPropertyUuid);
				if (slug === undefined) {
					unresolved.push({
						kind: part.kind,
						identity: part.userPropertyUuid,
					});
					out += "#user/[reference needs repair]";
				} else {
					out += `#user/${slug}`;
				}
				break;
			}
			case "search-answer-ref": {
				const name = ctx.searchInputName(part.searchInputUuid);
				if (name === undefined) {
					unresolved.push({
						kind: part.kind,
						identity: part.searchInputUuid,
					});
					out += "#search/[reference needs repair]";
				} else {
					out += `#search/${name}`;
				}
				break;
			}
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return unresolved.length === 0
		? { ok: true, text: out }
		: { ok: false, text: out, unresolved };
}
