// components/builder/shared/cards/expression/FormatDateCard.tsx
//
// Renders the `format-date` ValueExpression — render a date or
// datetime as text. Two slots:
//
//   - `date` — `ValueExpression` resolving to date or datetime.
//   - `pattern` — `"short" | "long" | "iso" | string` (a closed
//     enum or an arbitrary pattern string per CommCare's
//     `format-date(date, pattern)` value function).
//
// The pattern slot's two-branch union (preset enum vs. free-string)
// surfaces through the shared `CustomDatePatternInput` primitive
// (`primitives/CustomDatePatternInput.tsx`): segmented preset
// toggle row + free-text custom input + empty-pattern signal. The
// primitive is mounted by both this card and the column-side
// `DateColumnCard` so polish-passes apply once.
//
// Preset commits: this card supplies the FORMAT_DATE_PRESETS enum
// values verbatim as the preset patterns — the AST distinguishes
// preset (enum branch) from custom (string branch) and downstream
// consumers (wire emitter, type checker) read the discriminator.
// The column-side commits wire-form patterns instead since its
// schema flattens the union to `z.string().min(1)`.
//
// Type-checker rules (per `checkExpression`'s `case "format-date":`):
// the `date` operand must resolve to `date` or `datetime`. Errors
// land at `[..., "date"]`. Result type is always `text`.

"use client";
import {
	dateOperandConstraint,
	FORMAT_DATE_PRESETS,
	type FormatDatePreset,
	formatDate,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "../../primitives/CustomDatePatternInput";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

/** The `date` operand resolves to date or datetime — module-const for
 *  a stable identity across renders. */
const DATE_CONSTRAINT = dateOperandConstraint();

const PRESET_LABELS: Record<FormatDatePreset, string> = {
	short: "Short",
	long: "Long",
	iso: "ISO",
};

/**
 * Preset table for the format-date AST. Each preset commits the
 * enum value verbatim (`"short"` / `"long"` / `"iso"`) — the AST
 * keeps the preset-vs-custom distinction at the discriminator
 * level, and the wire emitter reads it.
 */
const FORMAT_DATE_PRESET_TABLE: readonly DatePatternPreset[] =
	FORMAT_DATE_PRESETS.map((preset) => ({
		id: preset,
		label: PRESET_LABELS[preset],
		pattern: preset,
	}));

/** Default — `format-date(today(), "short")`. The seed is a clean
 *  formatted date; the type checker validates the date operand and
 *  the result type resolves to text. */
export function formatDateDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "format-date" }> {
	return formatDate(today(), "short");
}

interface FormatDateCardProps {
	readonly value: Extract<ValueExpression, { kind: "format-date" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

export function FormatDateCard({ value, onChange, path }: FormatDateCardProps) {
	// Date-operand errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at `[..., "date"]`; no parallel
	// `<InlineError>` is needed here.

	const setDate = (next: ValueExpression) => {
		onChange(formatDate(next, value.pattern));
	};

	const setPattern = (next: string) => {
		onChange(formatDate(value.date, next));
	};

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-1">
					Date / datetime
				</div>
				<ExpressionPicker
					value={value.date}
					onChange={setDate}
					path={appendSlot(path, "date")}
					constraint={DATE_CONSTRAINT}
					variant="nested"
				/>
			</div>

			<div className="space-y-1.5">
				<div className="text-[10px] text-nova-text-muted uppercase tracking-wider">
					Date style
				</div>
				<CustomDatePatternInput
					value={value.pattern}
					onChange={setPattern}
					presets={FORMAT_DATE_PRESET_TABLE}
				/>
			</div>
		</div>
	);
}
