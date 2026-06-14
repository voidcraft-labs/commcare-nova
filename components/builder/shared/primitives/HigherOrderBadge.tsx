// components/builder/shared/primitives/HigherOrderBadge.tsx
//
// Read-only badge surfaced by the property pickers when the authored
// AST shape carries content the picker can't edit in place. Used by
// `PropertyRefPicker` for non-Term LEFT-slot shapes and Term-arm
// shapes that aren't canonical property references (multi-hop walks,
// non-prop Terms). The full ValueExpression editor (`ExpressionPicker`)
// edits every kind directly via the per-arm cards and does not need
// this badge.
//
// Round-trip preservation principle: any time a picker can't edit
// the authored shape directly, it renders this badge plus an
// explicit Replace button. No `onChange` fires until the user
// clicks Replace; the original AST round-trips through the editor
// untouched.

"use client";
import type { ValueExpression } from "@/lib/domain/predicate";

/**
 * Synthetic kinds used by the property pickers when the value
 * carries an authored shape the picker can't edit in place:
 *   - `term-non-prop` — a Term-arm Term that isn't a property
 *     reference (literal / search-input / session-context /
 *     session-user). Routes through the read-only badge so the
 *     authored Term isn't silently rewritten as a property.
 *   - `term-prop-with-via` — a `prop` Term carrying a non-self
 *     `via: RelationPath`. The picker's edit surface only knows
 *     how to swap the property name; rebuilding via `prop(case,
 *     name)` would drop the `via` walk. Routes through the badge
 *     so the relation walk can't disappear on a property click.
 *
 * Every Term variant other than the canonical "prop with no via
 * (or self via)" routes through these synthetic kinds so the
 * authored AST shape round-trips through the editor untouched
 * until the author explicitly clicks Replace.
 */
export type BadgeKind =
	| Exclude<ValueExpression["kind"], "term">
	| "term-non-prop"
	| "term-prop-with-via";

/** Human-readable labels for the badge kinds. The non-`term` arm
 *  keys cover every higher-order arm in `valueExpressionSchema`;
 *  the two synthetic rows label Term-arm shapes the property
 *  pickers can't edit. An exhaustive `Record<...>` over the
 *  closed kind set guarantees a label for every case. */
const HIGHER_ORDER_LABELS: Record<BadgeKind, string> = {
	today: "Today",
	now: "Now",
	"date-add": "Date arithmetic",
	"date-coerce": "Date coerce",
	"datetime-coerce": "Datetime coerce",
	double: "Numeric coerce",
	arith: "Arithmetic",
	concat: "Concatenation",
	coalesce: "Coalesce",
	if: "Conditional",
	switch: "Switch",
	count: "Relational count",
	"unwrap-list": "Unwrap list",
	"format-date": "Format date",
	"term-non-prop": "Non-property reference",
	"term-prop-with-via": "Property via relation walk",
};

/**
 * Read-only badge rendered when a picker receives a value shape
 * it can't edit. Surfaces the kind label (from
 * `HIGHER_ORDER_LABELS`) and a Replace affordance. The badge does
 * not call `onChange` on mount or render — only the user's
 * Replace click overwrites the underlying value.
 */
export function HigherOrderBadge({
	kind,
	onReplace,
	ariaLabel,
}: {
	readonly kind: BadgeKind;
	readonly onReplace: () => void;
	readonly ariaLabel: string;
}) {
	const label = HIGHER_ORDER_LABELS[kind];
	return (
		<div className="flex items-center gap-2 px-2 py-1.5 text-xs rounded-md border border-dashed border-white/[0.10] bg-nova-deep/30">
			<span className="text-nova-text-muted shrink-0">Expression:</span>
			<span className="font-mono text-nova-violet-bright/80 truncate">
				{label}
			</span>
			<div className="flex-1" />
			{/* Slot disambiguation lives on the Replace button's
			 *  aria-label — the only interactive element in the
			 *  badge — so a screen reader announces which slot's
			 *  expression the click would overwrite. */}
			<button
				type="button"
				aria-label={`Replace ${ariaLabel} expression (${label}) with a simple value`}
				onClick={onReplace}
				className="min-h-11 px-2 text-[10px] uppercase tracking-wider text-nova-text-muted/70 hover:text-nova-violet-bright transition-colors cursor-pointer"
			>
				Replace
			</button>
		</div>
	);
}
