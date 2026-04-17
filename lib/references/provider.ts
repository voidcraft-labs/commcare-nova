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
import { questionTypeIcons } from "@/lib/questionTypeIcons";
import {
	QUESTION_TYPES,
	STRUCTURAL_QUESTION_TYPES,
} from "@/lib/schemas/blueprint";
import { type QuestionPath, qpath } from "@/lib/services/questionPath";
import { REFERENCE_TYPES } from "./config";
import type { Reference, ReferenceType } from "./types";

/**
 * Question types that produce referenceable values — derived from
 * QUESTION_TYPES minus STRUCTURAL_QUESTION_TYPES. Used by FieldPicker,
 * XPath autocomplete (#form/), and TipTap reference chips to filter
 * suggestions down to fields that have values.
 */
export const VALUE_PRODUCING_TYPES: ReadonlySet<string> = new Set(
	QUESTION_TYPES.filter((t) => !STRUCTURAL_QUESTION_TYPES.has(t)),
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
			questionType: string;
		}>;
		byPath: Map<string, { label: string; questionType: string }>;
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
					icon: questionTypeIcons[e.questionType],
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
			const questionPath = path as QuestionPath;
			const cache = this.ensureFormCache(ctx);
			const found = cache.byPath.get(path);
			if (!found) return null;
			return {
				type,
				path: questionPath,
				raw,
				label: found.label ?? path,
				icon: questionTypeIcons[found.questionType],
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
			questionType: e.questionType,
		}));
		const byPath = new Map<string, { label: string; questionType: string }>();
		for (const e of entries) {
			byPath.set(e.path, { label: e.label, questionType: e.questionType });
		}
		this.formCache = { entries, byPath };
		return this.formCache;
	}
}

/**
 * Recursively collect question entries (path + label) from a legacy nested
 * `Question[]` tree.
 *
 * Retained for callers that still consume the wire-format tree (the
 * CommCare-side validators in lib/services/commcare). The CodeMirror
 * autocomplete and the XPath linter do NOT use this — they read directly
 * from the pre-collected `XPathLintContext.formEntries` produced by
 * `lib/codemirror/buildLintContext.ts`.
 */
export function collectQuestionEntries(
	questions: ReadonlyArray<{
		id: string;
		type: string;
		label?: string;
		children?: Array<unknown>;
	}>,
	parent?: QuestionPath,
): Array<{ path: QuestionPath; label: string; questionType: string }> {
	const entries: Array<{
		path: QuestionPath;
		label: string;
		questionType: string;
	}> = [];
	for (const q of questions) {
		const path = qpath(q.id, parent);
		entries.push({ path, label: q.label ?? path, questionType: q.type });
		if (q.children && (q.type === "group" || q.type === "repeat")) {
			entries.push(
				...collectQuestionEntries(
					q.children as Parameters<typeof collectQuestionEntries>[0],
					path,
				),
			);
		}
	}
	return entries;
}
