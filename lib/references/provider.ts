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
import { type FieldKind, fieldKinds, fieldRegistry } from "@/lib/domain";
import { fieldKindIcons } from "@/lib/fieldTypeIcons";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import { REFERENCE_TYPES } from "./config";
import type { Reference, ReferenceType } from "./types";

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

const VALID_TYPES = new Set<ReferenceType>(REFERENCE_TYPES);

/** Re-export of `qpath` for callers that previously used this module as
 *  the tree-walking helper. Kept alongside the provider so nothing breaks
 *  the `lib/references/provider` import surface. */
export { qpath };

export class ReferenceProvider {
	/** Cached form entries keyed by path. Rebuilt on `invalidate()`. */
	private formCache: {
		entries: ReadonlyArray<{
			path: QuestionPath;
			label: string;
			kind: string;
		}>;
		byPath: Map<string, { label: string; kind: string }>;
	} | null = null;

	constructor(private getContext: () => XPathLintContext | undefined) {}

	/** Clear cached data. Call when the blueprint or selection changes. */
	invalidate(): void {
		this.formCache = null;
	}

	/**
	 * Search references by type, filtered by a partial path query.
	 * Powers autocomplete in both CodeMirror and TipTap surfaces.
	 */
	search(type: ReferenceType, query: string): Reference[] {
		const lowerQuery = query.toLowerCase();

		if (type === "user") {
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

		const ctx = this.getContext();
		if (!ctx) return [];

		if (type === "form") {
			const cache = this.ensureFormCache(ctx);
			return cache.entries
				.filter(
					(e) =>
						e.path.toLowerCase().includes(lowerQuery) ||
						e.label.toLowerCase().includes(lowerQuery),
				)
				.map((e) => ({
					type: "form" as const,
					path: e.path,
					label: e.label,
					raw: `#form/${e.path}`,
					icon: fieldKindIcons[e.kind],
				}));
		}

		if (type === "case") {
			if (!ctx.caseProperties) return [];
			const results: Reference[] = [];
			for (const [name, meta] of ctx.caseProperties) {
				if (name.toLowerCase().includes(lowerQuery)) {
					results.push({
						type: "case",
						path: name,
						label: meta.label ?? name,
						raw: `#case/${name}`,
					});
				}
			}
			return results;
		}

		return [];
	}

	/**
	 * Resolve a canonical "#type/path" string to a Reference with label.
	 * Returns null if the format doesn't match or the reference doesn't
	 * exist in the current blueprint context.
	 */
	resolve(raw: string): Reference | null {
		const parsed = ReferenceProvider.parse(raw);
		if (!parsed) return null;

		const { type, path } = parsed;

		if (type === "user") {
			const prop = USER_PROPERTIES.find((p) => p.name === path);
			if (!prop) return null;
			return { type, path, label: prop.label, raw };
		}

		const ctx = this.getContext();
		if (!ctx) return null;

		if (type === "form") {
			const fieldPath = path as QuestionPath;
			const cache = this.ensureFormCache(ctx);
			const found = cache.byPath.get(path);
			if (!found) return null;
			return {
				type,
				path: fieldPath,
				raw,
				label: found.label ?? path,
				icon: fieldKindIcons[found.kind],
			};
		}

		if (type === "case") {
			const meta = ctx.caseProperties?.get(path);
			if (!meta) return null;
			return { type, path, label: meta.label ?? path, raw };
		}

		return null;
	}

	/**
	 * Parse a raw "#type/path" string into its namespace and path components.
	 * Pure string parsing — no blueprint lookup. The path is a plain string;
	 * callers construct the appropriate Reference variant with the correct
	 * path type (QuestionPath for form, string for case/user).
	 */
	static parse(raw: string): { type: ReferenceType; path: string } | null {
		if (!raw.startsWith("#")) return null;
		const slashIdx = raw.indexOf("/");
		if (slashIdx < 0) return null;
		const type = raw.slice(1, slashIdx);
		if (!VALID_TYPES.has(type as ReferenceType)) return null;
		const path = raw.slice(slashIdx + 1);
		if (!path) return null;
		return { type: type as ReferenceType, path };
	}

	// ── Private helpers ──────────────────────────────────────────────────

	/**
	 * Build the form-entries cache from the context's pre-collected
	 * `formEntries` list. The context hands us tuples with a leading-slash-
	 * free path (e.g. "group1/age"), which is exactly the `QuestionPath`
	 * shape used by the chip/resolve surfaces.
	 */
	private ensureFormCache(ctx: XPathLintContext) {
		if (this.formCache) return this.formCache;
		const entries = ctx.formEntries.map((e) => ({
			path: e.path as QuestionPath,
			label: e.label,
			kind: e.kind,
		}));
		const byPath = new Map<string, { label: string; kind: string }>();
		for (const e of entries) {
			byPath.set(e.path, { label: e.label, kind: e.kind });
		}
		this.formCache = { entries, byPath };
		return this.formCache;
	}
}

/** Minimal field projection consumed by `collectFieldEntries`. Narrow
 *  by design — the walker only needs `id`, `kind`, and optional `label`.
 *  Structural kinds (group, repeat) don't carry hint/validation data
 *  anyway, so this shape covers every domain Field variant. */
export interface FieldEntryField {
	readonly id: string;
	readonly kind: string;
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
	parent?: QuestionPath,
): Array<{ path: QuestionPath; label: string; kind: string }> {
	const entries: Array<{
		path: QuestionPath;
		label: string;
		kind: string;
	}> = [];
	const childUuids = src.fieldOrder[parentUuid] ?? [];
	for (const uuid of childUuids) {
		const field = src.fields[uuid];
		if (!field) continue;
		const path = qpath(field.id, parent);
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
