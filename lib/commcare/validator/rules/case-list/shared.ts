/** Shared property catalog and display labels for case-list validation. Expression
 * admission is always built from the actual stored slot with slotContext. */

import type { BlueprintDoc, CaseType, Column } from "@/lib/domain";
import {
	type CasePropertyDataType,
	effectiveDataType,
} from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	activeRowScope,
	type CheckPath,
	type ExpressionContext,
} from "@/lib/domain/expression";

/**
 * Per-doc validation context. Carries the augmented case-type list —
 * the rule-set-wide property admission set, which IS the domain's
 * effective case-type view (declared + standard + writer-derived,
 * with writer-derived `data_type`s resolved and honest-unknown kept
 * absent — see `lib/domain/effectiveCaseTypes.ts`). Consumers route
 * every property lookup through this list so the priority order has
 * exactly one structural home.
 */
export interface ValidationContext {
	readonly augmentedCaseTypes: readonly CaseType[];
}

const VALIDATION_CONTEXT_CACHE = new WeakMap<BlueprintDoc, ValidationContext>();

/**
 * The `ValidationContext` for the doc. The admission set itself is
 * memoized per doc reference inside `effectiveCaseTypes`; this wrapper is
 * memoized on the same document identity.
 */
export function validationContextFor(doc: BlueprintDoc): ValidationContext {
	const cached = VALIDATION_CONTEXT_CACHE.get(doc);
	if (cached !== undefined) return cached;

	const context = {
		augmentedCaseTypes: effectiveCaseTypes(doc),
	};
	VALIDATION_CONTEXT_CACHE.set(doc, context);
	return context;
}

/** A purpose-specific row projection for relation normalization; it never changes
 * or synthesizes the slot's checker context. */
export function relationEvaluationContext(ctx: ExpressionContext) {
	const row = activeRowScope(ctx);
	const caseRow =
		row?.kind === "case"
			? row
			: row?.kind === "table"
				? row.capturedCase
				: undefined;
	return { caseTypes: ctx.facts.caseTypes, currentCaseType: caseRow?.caseType };
}

/**
 * Format a `CheckPath` for inclusion in an error message — joins the
 * segments with `.` so the editor / SA can locate the offending node
 * inside the AST. An empty path renders as the empty string so the
 * surrounding sentence reads cleanly when the error attaches to the
 * predicate's own root.
 */
export function formatPath(path: CheckPath): string {
	if (path.length === 0) return "";
	return path
		.map((seg) => (typeof seg === "number" ? `[${seg}]` : seg))
		.join(".");
}

// ── Column handles ───────────────────────────────────────────────

/**
 * The handle a finding's message gives a column: `"<header>" (column #<n>)`,
 * where `index` is 0-based in whichever order the rule counts. A column with
 * no header is named by its property, and a calculated one with neither by
 * its position alone.
 */
export function describeColumn(column: Column, index: number): string {
	const header = column.header.trim();
	if (header.length > 0) return `"${header}" (column #${index + 1})`;
	if (column.kind !== "calculated" && column.field.trim().length > 0) {
		return `"${column.field}" (column #${index + 1})`;
	}
	return `column #${index + 1}`;
}

/** `describeColumn` where it begins a sentence. */
export function describeColumnAtSentenceStart(
	column: Column,
	index: number,
): string {
	const description = describeColumn(column, index);
	return description.charAt(0).toUpperCase() + description.slice(1);
}

/**
 * The label a finding's details carry for a column the builder names in its
 * own line: the header, or where it has none "a calculation" for a
 * calculated column and the property name for any other.
 */
export function caseListColumnLabel(column: Column): string {
	const header = column.header.trim();
	if (header.length > 0) return header;
	return column.kind === "calculated" ? "a calculation" : column.field;
}

// ── Property resolution helpers ──────────────────────────────────

/**
 * Resolve a property's effective `data_type` against the rule-set-
 * wide three-arm admission set. Returns `undefined` when the
 * property exists nowhere; callers report the missing-property as a
 * structural error.
 *
 * Priority order matches the contract in the file header:
 * declared → standard → writer-derived. The order is encoded once,
 * in `augmentCaseType` below; this resolver is a thin lookup
 * against the augmented list.
 */
export function resolvePropertyDataType(
	doc: BlueprintDoc,
	caseType: string,
	propertyName: string,
): CasePropertyDataType | undefined {
	const { augmentedCaseTypes } = validationContextFor(doc);
	return lookupInAugmented(augmentedCaseTypes, caseType, propertyName);
}

/**
 * `true` when the property exists in the rule-set-wide admission
 * set (declared, standard, or writer-derived). Thin existence
 * predicate for rules that don't need the resolved data type
 * (`columnReferences`).
 */
export function propertyExists(
	doc: BlueprintDoc,
	caseType: string,
	propertyName: string,
): boolean {
	return resolvePropertyDataType(doc, caseType, propertyName) !== undefined;
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Look up a property's effective data type in an already-augmented
 * case-type list. The augmented list IS the admission set (every
 * arm of the priority order is flattened into each `ct.properties[]`
 * by `augmentCaseType`), so this is a two-level lookup: case-type
 * by name, then property by name on the matched case type. Returns
 * `undefined` when either lookup misses.
 */
function lookupInAugmented(
	augmented: readonly CaseType[],
	caseType: string,
	propertyName: string,
): CasePropertyDataType | undefined {
	const ct = augmented.find((c) => c.name === caseType);
	const property = ct?.properties.find((p) => p.name === propertyName);
	return property ? effectiveDataType(property) : undefined;
}
