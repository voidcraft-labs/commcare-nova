// components/builder/case-list-config/cards/expression/UnwrapListCard.tsx
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

"use client";
import { Icon } from "@iconify/react/offline";
import tablerForklift from "@iconify-icons/tabler/forklift";
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
 *  operand" error. The kind isn't authored from the kind picker
 *  (the `applicable` predicate gates it on `expectedType ===
 *  "_sequence"`, which no scalar slot supplies) — the default
 *  factory exists for round-trip preservation symmetry, not for
 *  active authoring. */
export function unwrapListDefault(
	ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "unwrap-list" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find((p) =>
		["text", "single_select", "multi_select"].includes(p.data_type ?? "text"),
	);
	const propName = property?.name ?? "";
	return unwrapList(term(prop(ctx.currentCaseType, propName)));
}

interface UnwrapListCardProps {
	readonly value: Extract<ValueExpression, { kind: "unwrap-list" }>;
	// onChange is part of the registry's card-component contract.
	// This card is read-only — no editing affordance fires onChange.
	// The type is preserved so the registry's mapped-type guard
	// remains exhaustive over the kind union.
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

/**
 * Read-only sequence badge. The card shows the wrapped property
 * reference (when the operand is a Term/prop — the most common
 * shape) and surfaces a hint that the operator only applies in the
 * CSQL wire emitter's `selected-any(prop, unwrap-list(...))` form.
 * Authors who want scalar value-position editing flip the kind via
 * the parent shell's "Change" menu — `onChange` is part of the
 * card's prop contract but the badge body never fires it (no
 * editing affordances).
 */
export function UnwrapListCard({ value, path }: UnwrapListCardProps) {
	const valueErrors = useEditorErrorsAt(appendSlot(path, "value"));

	// Render the operand's shape verbatim. When the operand is a
	// Term/prop (the canonical shape), surface the property reference
	// inline; for any other shape, show "(expression)" so the badge
	// still reads but doesn't claim more than the editor knows.
	const operandSummary =
		value.value.kind === "term" && value.value.term.kind === "prop"
			? `${value.value.term.caseType}.${value.value.term.property || "(unset)"}`
			: "(expression)";

	return (
		<div className="space-y-2">
			<div className="flex items-start gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.08] bg-nova-deep/30">
				<Icon
					icon={tablerForklift}
					width="14"
					height="14"
					className="text-nova-violet-bright/70 mt-0.5 shrink-0"
				/>
				<div className="text-xs space-y-1 min-w-0">
					<div className="text-nova-text">
						Unwraps a JSON-encoded array stored in
						<span className="font-mono text-nova-violet-bright/80 mx-1">
							{operandSummary}
						</span>
						as a sequence of values.
					</div>
					<div className="text-[10px] text-nova-text-muted/70">
						CSQL-only operator — produces a sequence type that no scalar value
						slot consumes. The CSQL wire emitter routes it into{" "}
						<span className="font-mono">
							selected-any(prop, unwrap-list(…))
						</span>{" "}
						at the wire-emission boundary.
					</div>
				</div>
			</div>
			<InlineError errors={valueErrors} />
		</div>
	);
}
