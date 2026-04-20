/**
 * XPath transpiler — transforms Nova's XPath dialect into CommCare-
 * compatible XPath 1.0.
 *
 * Nova's evaluator intentionally extends XPath with better type
 * semantics (e.g. date-aware arithmetic). The transpiler bridges the
 * gap at export time: it walks the Lezer CST, infers expression types,
 * and applies a pipeline of source-level transforms that produce
 * equivalent XPath 1.0 for CommCare's runtime.
 *
 * ## Architecture
 *
 * ```
 *  source string
 *       │
 *       ▼
 *  Lezer parse  ──▶  type inference  ──▶  TypeMap
 *       │                                     │
 *       └─────────────┬───────────────────────┘
 *                      ▼
 *               Pass pipeline
 *           (each pass reads the tree + TypeMap,
 *            emits a list of SourceEdits)
 *                      │
 *                      ▼
 *              applyEdits(source, edits)
 *                      │
 *                      ▼
 *            CommCare-compatible XPath 1.0
 * ```
 *
 * ## Adding a new pass
 *
 * 1. Create a file in `passes/` that exports a {@link Pass} function.
 * 2. Add it to the `PASSES` array below.
 * 3. Write tests. The pass receives the full type map and parse tree —
 *    it never needs to re-parse or re-infer.
 *
 * Passes run in declaration order. Each pass sees the **original**
 * source and tree (not the output of a previous pass), but edits from
 * all passes are merged before applying. This keeps passes independent
 * and avoids cascading re-parse overhead. If a future pass needs to
 * operate on already-transformed output, we'll add a multi-stage
 * pipeline — but for now single-stage is simpler and sufficient.
 */

import type { Tree } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";
import { dateArithmetic } from "./passes/dateArithmetic";
import type { TypeMap } from "./typeInfer";
import { inferTypes } from "./typeInfer";

// ── Public types ────────────────────────────────────────────────────

/**
 * A single source-level edit: replace the character range
 * `[from, to)` with `replacement`.
 */
export interface SourceEdit {
	from: number;
	to: number;
	replacement: string;
}

/**
 * A transpiler pass. Receives the parsed tree, inferred type map, and
 * original source — returns zero or more source edits.
 *
 * Passes must be **pure**: same inputs → same edits. They must not
 * produce overlapping edit ranges (the pipeline will throw if they do).
 */
export type Pass = (tree: Tree, types: TypeMap, source: string) => SourceEdit[];

// ── Pass registry ───────────────────────────────────────────────────

/**
 * Ordered list of transform passes. Add new passes here.
 * Each entry is `[human-readable name, pass function]`.
 */
const PASSES: [string, Pass][] = [["dateArithmetic", dateArithmetic]];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Transpile a Nova XPath expression to CommCare-compatible XPath 1.0.
 *
 * Returns the source unchanged if no transforms apply (common case).
 * Throws on parse errors or conflicting edits (indicates a pass bug).
 */
export function transpile(source: string): string {
	const trimmed = source.trim();
	if (!trimmed) return source;

	const tree = parser.parse(trimmed);

	/* Bail on parse errors — pass through as-is, let the validator catch it */
	let hasError = false;
	tree.iterate({
		enter(n) {
			if (n.type.name === "⚠") hasError = true;
		},
	});
	if (hasError) return source;

	const types = inferTypes(tree, trimmed);
	const allEdits: SourceEdit[] = [];

	for (const [name, pass] of PASSES) {
		const edits = pass(tree, types, trimmed);
		for (const edit of edits) {
			if (edit.from < 0 || edit.to > trimmed.length || edit.from > edit.to) {
				throw new Error(
					`Pass "${name}" produced out-of-bounds edit: [${edit.from}, ${edit.to})`,
				);
			}
		}
		allEdits.push(...edits);
	}

	if (allEdits.length === 0) return source;
	return applyEdits(trimmed, allEdits);
}

// ── Edit application ────────────────────────────────────────────────

/**
 * Apply a set of non-overlapping source edits to produce the
 * transformed string. Edits are sorted back-to-front so that earlier
 * offsets remain valid after later replacements.
 */
function applyEdits(source: string, edits: SourceEdit[]): string {
	/* Sort descending by `from` — apply from end to preserve offsets */
	const sorted = [...edits].sort((a, b) => b.from - a.from);

	/* Validate no overlaps */
	for (let i = 0; i < sorted.length - 1; i++) {
		const current = sorted[i];
		const next = sorted[i + 1];
		if (next.to > current.from) {
			throw new Error(
				`Overlapping edits: [${next.from},${next.to}) and [${current.from},${current.to})`,
			);
		}
	}

	let result = source;
	for (const { from, to, replacement } of sorted) {
		result = result.slice(0, from) + replacement + result.slice(to);
	}
	return result;
}
