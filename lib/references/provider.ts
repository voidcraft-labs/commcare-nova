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
	caseRefAcceptMap,
	type FieldKind,
	fieldKinds,
	fieldRegistry,
} from "@/lib/domain";
import { classifyNamespace } from "./config";
import type { Reference } from "./types";

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
export const USER_PROPERTIES: ReadonlyArray<{ name: string; label: string }> = [
	{ name: "username", label: "Username" },
	{ name: "first_name", label: "First Name" },
	{ name: "last_name", label: "Last Name" },
	{ name: "phone_number", label: "Phone Number" },
];

const NAMESPACE_RE = /^[A-Za-z_]\w*$/;

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
	byPath: Map<string, { label: string; kind: FieldKind }>;
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
	search(namespace: string, query: string, formUuid?: string): Reference[] {
		const lowerQuery = query.toLowerCase();

		if (namespace === "user") {
			return USER_PROPERTIES.filter(
				(p) =>
					p.name.includes(lowerQuery) ||
					p.label.toLowerCase().includes(lowerQuery),
			).map((p) => ({
				type: "user",
				path: p.name,
				label: p.label,
				raw: `#user/${p.name}`,
			}));
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
	resolve(raw: string, formUuid?: string): Reference | null {
		const parsed = ReferenceProvider.parse(raw);
		if (!parsed) return null;

		if (parsed.type === "user") {
			const prop = USER_PROPERTIES.find((p) => p.name === parsed.path);
			if (!prop) return null;
			return { type: "user", path: parsed.path, label: prop.label, raw };
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
		};
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
		const byPath = new Map<string, { label: string; kind: FieldKind }>();
		for (const e of ctx.formEntries) {
			byPath.set(e.path, { label: e.label, kind: e.kind });
		}
		const accept = ctx.reachableCaseTypes
			? caseRefAcceptMap(ctx.reachableCaseTypes, ctx.formType)
			: new Map<string, Set<string>>();
		const entry: FormCacheEntry = { ctx, byPath, accept };
		this.caches.set(formUuid, entry);
		return entry;
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
	readonly id: string;
	readonly kind: FieldKind;
	readonly label?: string;
}

/** Minimal doc projection consumed by `collectFieldEntries`. */
export interface FieldEntrySource {
	readonly fields: Readonly<Record<string, FieldEntryField>>;
	readonly fieldOrder: Readonly<Record<string, readonly string[]>>;
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
	parentUuid: string,
	parent?: FieldPath,
): Array<{ path: FieldPath; label: string; kind: FieldKind }> {
	const entries: Array<{
		path: FieldPath;
		label: string;
		kind: FieldKind;
	}> = [];
	const childUuids = src.fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const field = src.fields[uuid];
		if (!field) continue;
		const path = fpath(field.id, parent);
		entries.push({
			path,
			label: field.label ?? path,
			kind: field.kind,
		});
		if (field.kind === "group" || field.kind === "repeat") {
			entries.push(...collectFieldEntries(src, uuid, path));
		}
	}
	return entries;
}
