// components/builder/shared/cards/expression/UnwrapListCard.tsx
//
// Renders the `unwrap-list` ValueExpression as a read-only badge.
// `unwrap-list` produces a `_sequence` resolved type that no scalar
// value slot consumes — the only consuming surface is the CSQL wire
// emitter via `selected-any(prop, unwrap-list(...))` at the wire-
// emission boundary. The Postgres compiler defensive-throws on this
// arm because no Postgres-side AST consumer accepts a sequence.
//
// Why a badge rather than a non-mounting refusal: round-trip
// preservation is structural in the editor — every kind that lands
// in a saved AST MUST round-trip through the editor without
// destruction. Refusing to mount would force the AST to be
// rewritten before display, which violates the round-trip contract.
// The badge surfaces the authored shape without offering scalar
// editing affordances; the kind-replace menu on the parent shell
// handles the path back to a scalar shape.
//
// Lossless recovery affordance: a "Replace" button swaps
// `unwrap-list(<inner>)` for the inner expression directly. Authors
// who land on this card with an unrepairable inner shape (e.g. a
// stale property reference) can recover without losing the inner
// expression — the kind-replace menu on the parent shell would
// otherwise discard the operand via `defaultValue(...)`. The card
// stays read-only on the value slot itself; the inner expression
// only re-enters the editor through the unwrap collapse, then
// becomes editable through whatever its native card surfaces.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerForklift from "@iconify-icons/tabler/forklift";
import { isTextShaped } from "@/lib/domain";
import {
	prop,
	term,
	unwrapList,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { InlineError } from "../../primitives/CardShell";

/** Default `unwrap-list` — `unwrap-list(prop(currentCaseType,
 *  firstTextProperty))`. The default seeds against the first text-
 *  shaped property on the current case type so the type checker
 *  accepts the seed without an "unwrap-list requires a text-shaped
 *  operand" error. The shared `isTextShaped` helper (in
 *  `lib/domain/casePropertyTypes.ts`) consolidates the
 *  `data_type ?? "text"` fallback every consumer applies. The kind
 *  isn't authored from the kind picker (the `applicable` predicate
 *  gates it on `expectedType === "_sequence"`, which no scalar slot
 *  supplies) — the default factory exists for round-trip
 *  preservation symmetry, not for active authoring. */
export function unwrapListDefault(
	ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "unwrap-list" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find(isTextShaped);
	const propName = property?.name ?? "";
	return unwrapList(term(prop(ctx.currentCaseType, propName)));
}

interface UnwrapListCardProps {
	readonly value: Extract<ValueExpression, { kind: "unwrap-list" }>;
	// onChange is fired ONLY by the "Replace" affordance below — the
	// card is otherwise read-only on the value slot itself. The
	// recovery path collapses `unwrap-list(<inner>)` to `<inner>` so
	// the user can repair an unrepairable inner shape without losing
	// the operand to a kind-replace default.
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

/**
 * Read-only sequence badge with a lossless "Replace" affordance.
 *
 * The card shows the wrapped property reference (when the operand
 * is a Term/prop — the most common shape) and a plain-words hint
 * that a list of values only fits inside choice comparisons (the
 * wire-level truth: only the CSQL emitter's `selected-any(prop,
 * unwrap-list(...))` form consumes it). Authors who want scalar
 * value-position editing have two paths:
 *
 *   1. Click "Replace" — collapses
 *      `unwrap-list(<inner>)` to `<inner>` directly, which then
 *      becomes editable through whatever card the inner expression's
 *      kind dispatches to. Lossless: the inner expression survives
 *      the unwrap.
 *   2. Use the parent shell's "Change" kind-replace menu —
 *      destructive: the target kind's default-value factory rebuilds
 *      from scratch, the inner expression is lost.
 *
 * Path (1) is the canonical recovery path for repairing a saved
 * `unwrap-list` whose inner expression has gone stale (e.g. a
 * property reference whose target was renamed). The card body has
 * no recursive `ExpressionPicker` — that would re-admit
 * `unwrap-list` as an authorable kind through the inner picker's
 * own kind menu, defeating the round-trip-only contract.
 */
export function UnwrapListCard({ value, onChange, path }: UnwrapListCardProps) {
	const valueErrors = useEditorErrorsAt(appendSlot(path, "value"));

	// Render the operand's shape verbatim. When the operand is a
	// Term/prop (the canonical shape), surface the property reference
	// inline; for any other shape, show "(formula)" so the badge
	// still reads but doesn't claim more than the editor knows.
	const operandSummary =
		value.value.kind === "term" && value.value.term.kind === "prop"
			? `${value.value.term.caseType}.${value.value.term.property || "(unset)"}`
			: "(formula)";

	return (
		<div className="space-y-2">
			<div className="flex items-start gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.08] bg-nova-deep/30">
				<Icon
					icon={tablerForklift}
					width="14"
					height="14"
					className="text-nova-violet-bright mt-0.5 shrink-0"
				/>
				<div className="text-xs space-y-1 min-w-0 flex-1">
					<div className="text-nova-text">
						Every option selected in
						<span className="font-mono text-nova-violet-bright mx-1">
							{operandSummary}
						</span>
						, as a list.
					</div>
					<div className="text-[10px] text-nova-text-muted">
						A list of values only fits inside choice comparisons — it can't
						stand where a single value is expected. Replace it to edit the value
						inside.
					</div>
				</div>
				<button
					type="button"
					onClick={() => onChange(value.value)}
					aria-label="Replace with the value inside"
					className="min-h-11 px-2 text-[10px] uppercase tracking-wider text-nova-text-muted hover:text-nova-violet-bright transition-colors cursor-pointer shrink-0"
				>
					Replace
				</button>
			</div>
			<InlineError errors={valueErrors} />
		</div>
	);
}
