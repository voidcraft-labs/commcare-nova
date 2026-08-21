/**
 * ReferenceProvider — unified API for searching and resolving hashtag references.
 *
 * Wraps the existing blueprint resolution functions into a single interface
 * consumed by both CodeMirror chip decorations and TipTap suggestion/autocomplete.
 *
 * Consumes the thin `XPathLintContext` pre-collected by `buildLintContext` —
 * no nested-tree walking here anymore. All the information the provider needs
 * (form field entries, case property names + labels, valid paths) lives on
 * that context already; the provider caches the derived search indexes so
 * per-keystroke autocomplete lookups stay O(entries) even without re-walking.
 */

import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { type FieldPath, fpath } from "@/lib/doc/fieldPath";
import {
	BUILT_IN_USER_PROPERTIES,
	caseRefAcceptMap,
	type FieldKind,
	fieldKinds,
	fieldRegistry,
	HASHTAG_SEGMENT_SOURCE,
	type ProseProjectionResult,
	type ProseReferencePart,
	type ProseTemplate,
	projectProseTemplate,
	type Uuid,
	type XPathPrintableDoc,
} from "@/lib/domain";
import { classifyNamespace } from "./config";
import type { Reference, ReferenceType } from "./types";

/**
 * The pure (no-lookup) parse of a `#namespace/path` string. The namespace is
 * the token between `#` and the first `/`: `form` / `user` are the fixed
 * families; any other identifier is a case type, captured on `caseType`.
 */
export type ParsedReference =
	| { type: "form"; path: string }
	| { type: "user"; path: string }
	| { type: "case"; caseType: string; path: string };

/**
 * Field kinds that produce referenceable values — derived from the
 * domain registry's `isStructural` flag. Groups, repeats, and labels
 * are structural; everything else produces a value that can be written
 * to a case or referenced from XPath. Used by FieldPicker, XPath
 * autocomplete (#form/), and TipTap reference chips.
 *
 * Keyed on the domain `FieldKind` union so new kinds automatically
 * participate based on their metadata — no separate list to maintain.
 */
export const VALUE_PRODUCING_TYPES: ReadonlySet<FieldKind> = new Set(
	fieldKinds.filter((k) => !fieldRegistry[k].isStructural),
);

/** User properties with human-readable labels — single source of truth. */
export const USER_PROPERTIES = BUILT_IN_USER_PROPERTIES.map((property) => ({
	name: property.slug,
	label: property.label,
}));

export type ReferenceSurface = "prose" | "xpath";

/**
 * A typed reference that cannot be projected through the owning form.
 * `repairText` is deliberately identity-free: the UUID remains available only
 * in the stored part and never becomes authored display text.
 */
export interface UnresolvedReferenceProjection {
	readonly kind: "unresolved-reference";
	readonly referenceKind: ProseReferencePart["kind"];
	readonly type: ReferenceType;
	readonly repairText: string;
}

export type ReferencePartProjection =
	| { readonly ok: true; readonly reference: Reference }
	| {
			readonly ok: false;
			readonly unresolved: UnresolvedReferenceProjection;
	  };

export type ReferenceTemplateProjection =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly text: string;
			readonly unresolved: readonly UnresolvedReferenceProjection[];
	  };

/** A namespace is exactly one hashtag segment — same vocabulary as the
 *  shared matcher source, anchored to the whole token. */
const NAMESPACE_RE = new RegExp(`^${HASHTAG_SEGMENT_SOURCE}$`);

/** Re-export of `fpath` for callers that previously used this module as
 *  the tree-walking helper. Kept alongside the provider so nothing breaks
 *  the `lib/references/provider` import surface. */
export { fpath };

/** A cached form scope: the form's lint context plus the derived indexes the
 *  hot paths read. `byPath` is the `#form/` path index; `accept` is the
 *  per-case-type accept map already narrowed by form type (so resolve/search/
 *  namespaces never re-run the narrowing rule and never disagree with the
 *  validator). */
interface FormCacheEntry {
	ctx: XPathLintContext;
	byPath: Map<string, { uuid: Uuid; label: string; kind: FieldKind }>;
	byUuid: Map<Uuid, { path: FieldPath; label: string; kind: FieldKind }>;
	accept: Map<string, Set<string>>;
}

export class ReferenceProvider {
	/** Per-form cache, keyed by form uuid: the lint context + its derived
	 *  indexes. Built lazily and cleared wholesale by `invalidate()` on any
	 *  blueprint mutation. A Map (not a single slot) because one render — the
	 *  app-tree sidebar — resolves refs across many forms at once; a single slot
	 *  would thrash. Caching the whole context (not just `byPath`) keeps the
	 *  sidebar from re-walking the form tree once per chip. */
	private caches = new Map<string, FormCacheEntry>();

	/**
	 * @param getContextForForm Resolve the lint context for a given form uuid.
	 *   The app-wide provider builds it from the doc store; a per-editor
	 *   provider may ignore the argument and return its single bound form.
	 */
	constructor(
		private getContextForForm: (
			formUuid: string,
		) => XPathLintContext | undefined,
	) {}

	/** Clear all cached form scopes. Call when the blueprint mutates. */
	invalidate(): void {
		this.caches.clear();
	}

	/**
	 * Search references in a namespace, filtered by a partial query. Powers
	 * autocomplete in both CodeMirror and TipTap surfaces. `namespace` is
	 * `"form"`, `"user"`, or a case-type name. `user` needs no form scope;
	 * `form` and case namespaces resolve against `formUuid`'s context. Case
	 * results are narrowed by the same `accept` map the validator uses, so the
	 * autocomplete never offers a ref the validator would reject.
	 */
	search(
		namespace: string,
		query: string,
		formUuid?: string,
		_surface: ReferenceSurface = "prose",
	): Reference[] {
		const lowerQuery = query.toLowerCase();

		if (namespace === "user") {
			const custom =
				formUuid !== undefined
					? (this.getContextForForm(formUuid)?.userProperties ?? [])
					: [];
			const customSlugs = new Set(custom.map((property) => property.slug));
			const customResults: Reference[] = custom
				.filter(
					(property) =>
						property.slug.toLowerCase().includes(lowerQuery) ||
						property.label.toLowerCase().includes(lowerQuery),
				)
				.map((property) => ({
					type: "user",
					path: property.slug,
					label: `${property.label} (${property.slug})`,
					raw: `#user/${property.slug}`,
					part: {
						kind: "user-property-ref",
						userPropertyUuid: property.uuid,
					},
				}));
			const builtInResults: Reference[] = USER_PROPERTIES.filter(
				(p) =>
					!customSlugs.has(p.name) &&
					(p.name.includes(lowerQuery) ||
						p.label.toLowerCase().includes(lowerQuery)),
			).map((p) => ({
				type: "user",
				path: p.name,
				label: p.label,
				raw: `#user/${p.name}`,
				part: { kind: "user-ref", property: p.name },
			}));
			return [...customResults, ...builtInResults];
		}

		if (!formUuid) return [];
		const cache = this.ensureCache(formUuid);
		if (!cache) return [];

		if (namespace === "form") {
			const results: Reference[] = [];
			for (const [path, meta] of cache.byPath) {
				if (
					path.toLowerCase().includes(lowerQuery) ||
					meta.label.toLowerCase().includes(lowerQuery)
				) {
					results.push({
						type: "form",
						path: path as FieldPath,
						label: meta.label,
						raw: `#form/${path}`,
						part: { kind: "field-ref", uuid: meta.uuid },
						icon: fieldRegistry[meta.kind].icon,
					});
				}
			}
			return results;
		}

		// Case namespace — only the properties the accept map admits for this
		// form (registration narrows the own type to `case_id`). Labels come
		// from the full reachable index.
		const allowed = cache.accept.get(namespace);
		if (!allowed) return [];
		const typeEntry = cache.ctx.reachableCaseTypes?.get(namespace);
		const results: Reference[] = [];
		for (const name of allowed) {
			if (name.toLowerCase().includes(lowerQuery)) {
				results.push({
					type: "case",
					caseType: namespace,
					path: name,
					label: typeEntry?.properties.get(name)?.label ?? name,
					raw: `#${namespace}/${name}`,
					part: { kind: "case-ref", caseType: namespace, property: name },
				});
			}
		}
		return results;
	}

	/**
	 * Resolve a `#namespace/path` string to a Reference with label, scoped to
	 * `formUuid`. Returns null when the format is malformed OR the reference
	 * doesn't resolve in that form's context (the gate that keeps an
	 * unresolvable ref from rendering as a chip). `user` refs are global and
	 * need no form; `form`/case refs require `formUuid` + its context. Case
	 * refs go through the same `accept` map the validator uses, so a chip
	 * renders only for refs the validator would also accept.
	 */
	resolve(
		raw: string,
		formUuid?: string,
		_surface: ReferenceSurface = "prose",
	): Reference | null {
		const parsed = ReferenceProvider.parse(raw);
		if (!parsed) return null;

		if (parsed.type === "user") {
			if (formUuid !== undefined) {
				// Custom worker properties are mutable identities. Resolve them
				// from the live context rather than the cached form index so a
				// rename updates chips immediately without rewriting the XPath
				// AST or waiting for an editor remount.
				const custom = this.getContextForForm(formUuid)?.userProperties?.find(
					(property) => property.slug === parsed.path,
				);
				if (custom !== undefined) {
					return {
						type: "user",
						path: custom.slug,
						label: `${custom.label} (${custom.slug})`,
						raw,
						part: {
							kind: "user-property-ref",
							userPropertyUuid: custom.uuid,
						},
					};
				}
			}
			const prop = USER_PROPERTIES.find((p) => p.name === parsed.path);
			if (!prop) return null;
			return {
				type: "user",
				path: parsed.path,
				label: prop.label,
				raw,
				part: { kind: "user-ref", property: prop.name },
			};
		}

		if (!formUuid) return null;
		const cache = this.ensureCache(formUuid);
		if (!cache) return null;

		if (parsed.type === "form") {
			const found = cache.byPath.get(parsed.path);
			if (!found) return null;
			return {
				type: "form",
				path: parsed.path as FieldPath,
				raw,
				label: found.label ?? parsed.path,
				part: { kind: "field-ref", uuid: found.uuid },
				icon: fieldRegistry[found.kind].icon,
			};
		}

		// Case ref — resolvable only if the accept map admits this type +
		// property for this form (registration narrows the own type to
		// `case_id`). The label comes from the full reachable index.
		if (!cache.accept.get(parsed.caseType)?.has(parsed.path)) return null;
		const meta = cache.ctx.reachableCaseTypes
			?.get(parsed.caseType)
			?.properties.get(parsed.path);
		return {
			type: "case",
			caseType: parsed.caseType,
			path: parsed.path,
			label: meta?.label ?? parsed.path,
			raw,
			part: {
				kind: "case-ref",
				caseType: parsed.caseType,
				property: parsed.path,
			},
		};
	}

	/** Resolve an already-typed prose part without parsing a display path. */
	resolvePart(part: ProseReferencePart, formUuid?: string): Reference | null {
		if (part.kind === "user-ref") {
			const property = USER_PROPERTIES.find((p) => p.name === part.property);
			return {
				type: "user",
				path: part.property,
				label: property?.label ?? part.property,
				raw: `#user/${part.property}`,
				part,
			};
		}
		if (!formUuid) return null;
		const cache = this.ensureCache(formUuid);
		if (!cache) return null;
		if (part.kind === "user-property-ref") {
			const property = cache.ctx.userProperties?.find(
				(candidate) => candidate.uuid === part.userPropertyUuid,
			);
			return property
				? {
						type: "user",
						path: property.slug,
						label: `${property.label} (${property.slug})`,
						raw: `#user/${property.slug}`,
						part,
					}
				: null;
		}
		if (part.kind === "field-ref") {
			const field = cache.byUuid.get(part.uuid);
			return field
				? {
						type: "form",
						path: field.path,
						label: field.label,
						raw: `#form/${field.path}`,
						part,
						icon: fieldRegistry[field.kind].icon,
					}
				: null;
		}
		const allowed = cache.accept.get(part.caseType);
		if (!allowed?.has(part.property)) return null;
		return {
			type: "case",
			caseType: part.caseType,
			path: part.property,
			label:
				cache.ctx.reachableCaseTypes
					?.get(part.caseType)
					?.properties.get(part.property)?.label ?? part.property,
			raw: `#${part.caseType}/${part.property}`,
			part,
		};
	}

	/**
	 * Resolve a stored part to its current friendly reference, or return the
	 * structured repair state a human surface must render. Callers must not
	 * reconstruct a display path from the stored identity.
	 */
	projectPart(
		part: ProseReferencePart,
		formUuid?: string,
	): ReferencePartProjection {
		const reference = this.resolvePart(part, formUuid);
		return reference === null
			? { ok: false, unresolved: unresolvedReferenceProjection(part) }
			: { ok: true, reference };
	}

	/** Current identity-safe plain-text projection used by compact/search surfaces. */
	projectTemplate(
		template: ProseTemplate,
		formUuid?: string,
	): ReferenceTemplateProjection {
		let result = "";
		const unresolved: UnresolvedReferenceProjection[] = [];
		for (const part of template.parts) {
			if (part.kind === "text") result += part.text;
			else {
				const projected = this.projectPart(part, formUuid);
				if (projected.ok) result += projected.reference.raw;
				else {
					unresolved.push(projected.unresolved);
					result += projected.unresolved.repairText;
				}
			}
		}
		return unresolved.length === 0
			? { ok: true, text: result }
			: { ok: false, text: result, unresolved };
	}

	/**
	 * The namespaces offered at the `#`-stage of autocomplete for a form:
	 * always `form` + `user`, plus one per case type the `accept` map admits
	 * (so a registration form offers only its own type, never ancestors).
	 * Returns just `form`/`user` when no form scope is supplied.
	 */
	namespaces(formUuid?: string): string[] {
		const base = ["form", "user"];
		if (!formUuid) return base;
		const cache = this.ensureCache(formUuid);
		if (!cache) return base;
		return [...base, ...cache.accept.keys()];
	}

	/**
	 * Parse a raw `#namespace/path` string into its namespace + path. Pure
	 * string parsing — no blueprint lookup. The namespace must be a legal
	 * identifier; `classifyNamespace` decides the family (`form`/`user` fixed,
	 * anything else a case type carried on `caseType`).
	 */
	static parse(raw: string): ParsedReference | null {
		if (!raw.startsWith("#")) return null;
		const slashIdx = raw.indexOf("/");
		if (slashIdx < 0) return null;
		const ns = raw.slice(1, slashIdx);
		if (!NAMESPACE_RE.test(ns)) return null;
		// `case` is CommCare-private projection vocabulary, never an authored
		// Nova namespace. Canonical case refs name their actual case type.
		if (ns === "case") return null;
		const path = raw.slice(slashIdx + 1);
		if (!path) return null;
		const family = classifyNamespace(ns);
		return family === "case"
			? { type: "case", caseType: ns, path }
			: { type: family, path };
	}

	// ── Private helpers ──────────────────────────────────────────────────

	/**
	 * Build (or reuse) the cached scope for a form: its lint context plus the
	 * `#form/` path index and the narrowed per-type accept map. One full
	 * `getContextForForm` walk per form per invalidation cycle; every resolve /
	 * search / namespace lookup after that reads the cache.
	 */
	private ensureCache(formUuid: string): FormCacheEntry | undefined {
		const cached = this.caches.get(formUuid);
		if (cached) return cached;
		const ctx = this.getContextForForm(formUuid);
		if (!ctx) return undefined;
		const byPath = new Map<
			string,
			{ uuid: Uuid; label: string; kind: FieldKind }
		>();
		const byUuid = new Map<
			Uuid,
			{ path: FieldPath; label: string; kind: FieldKind }
		>();
		for (const e of ctx.formEntries) {
			byPath.set(e.path, { uuid: e.uuid, label: e.label, kind: e.kind });
			byUuid.set(e.uuid, {
				path: e.path as FieldPath,
				label: e.label,
				kind: e.kind,
			});
		}
		const accept = ctx.reachableCaseTypes
			? caseRefAcceptMap(
					ctx.reachableCaseTypes,
					ctx.formType,
					ctx.scope ?? "form",
				)
			: new Map<string, Set<string>>();
		const entry: FormCacheEntry = { ctx, byPath, byUuid, accept };
		this.caches.set(formUuid, entry);
		return entry;
	}
}

export function unresolvedReferenceProjection(
	part: ProseReferencePart,
): UnresolvedReferenceProjection {
	switch (part.kind) {
		case "field-ref":
			return {
				kind: "unresolved-reference",
				referenceKind: part.kind,
				type: "form",
				repairText: "#form/[reference needs repair]",
			};
		case "case-ref":
			return {
				kind: "unresolved-reference",
				referenceKind: part.kind,
				type: "case",
				repairText: `#${part.caseType}/[reference needs repair]`,
			};
		case "user-property-ref":
			return {
				kind: "unresolved-reference",
				referenceKind: part.kind,
				type: "user",
				repairText: "#user/[reference needs repair]",
			};
		case "user-ref":
			return {
				kind: "unresolved-reference",
				referenceKind: part.kind,
				type: "user",
				repairText: "#user/[reference needs repair]",
			};
		default: {
			const _exhaustive: never = part;
			return _exhaustive;
		}
	}
}

/** Minimal field projection consumed by `collectFieldEntries`. Narrow
 *  by design — the walker only needs `id`, `kind`, and optional `label`.
 *  Structural kinds (group, repeat) don't carry hint/validation data
 *  anyway, so this shape covers every domain Field variant.
 *
 *  `kind` is the domain `FieldKind` union so downstream consumers
 *  (FieldPicker icon lookup, autocomplete chip rendering) can index
 *  `fieldRegistry` without a widening cast. */
export interface FieldEntryField {
	readonly uuid: Uuid;
	readonly id: string;
	readonly kind: FieldKind;
	readonly label?: ProseTemplate;
}

/** Owning-document projection consumed by `collectFieldEntries`. Labels may
 * contain UUID-backed references, so fields/order alone cannot distinguish a
 * valid current path from a dangling identity. */
export interface FieldEntrySource {
	readonly fields: Readonly<Record<string, FieldEntryField>>;
	readonly fieldOrder: Readonly<Record<string, readonly Uuid[]>>;
	readonly forms: XPathPrintableDoc["forms"];
	readonly fieldParent?: XPathPrintableDoc["fieldParent"];
	readonly userProperties?: XPathPrintableDoc["userProperties"];
}

/**
 * Depth-first walk of the normalized doc collecting `(path, label, kind)`
 * tuples for every descendant field of `parentUuid`. Used by the
 * FieldPicker UI to render a flat searchable list of fields within a
 * form.
 *
 * The walker operates directly on the doc's `fields` + `fieldOrder`
 * maps — no wire-format assembly is involved. For container kinds
 * (group, repeat) it recurses into their own `fieldOrder` entry; leaf
 * kinds bottom out naturally because leaves have no order entry.
 */
export function collectFieldEntries(
	src: FieldEntrySource,
	parentUuid: Uuid,
	parent?: FieldPath,
): Array<{
	uuid: Uuid;
	path: FieldPath;
	label: string;
	labelProjection: ProseProjectionResult;
	kind: FieldKind;
}> {
	const entries: Array<{
		uuid: Uuid;
		path: FieldPath;
		label: string;
		labelProjection: ProseProjectionResult;
		kind: FieldKind;
	}> = [];
	const childUuids = src.fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const field = src.fields[uuid];
		if (!field) continue;
		const path = fpath(field.id, parent);
		const labelProjection = field.label
			? projectProseTemplate(field.label, src)
			: ({ ok: true, text: path } as const);
		entries.push({
			uuid: field.uuid,
			path,
			label: labelProjection.text.trim() || path,
			labelProjection,
			kind: field.kind,
		});
		if (fieldRegistry[field.kind].isContainer) {
			entries.push(...collectFieldEntries(src, uuid, path));
		}
	}
	return entries;
}
