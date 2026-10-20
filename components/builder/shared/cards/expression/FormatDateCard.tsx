// components/builder/shared/cards/expression/FormatDateCard.tsx
//
// Renders the `format-date` Expression: render a date or
// datetime as text. Two slots:
//
//   - `date`: `Expression` resolving to date or datetime.
//   - `pattern`: `"short" | "long" | "iso" | string` (a closed
//     enum or a validated JavaRosa pattern string per CommCare's
//     `format-date(date, pattern)` value function).
//
// The pattern slot's two-branch union (preset enum vs. free-string)
// surfaces through the shared `CustomDatePatternInput` primitive
// (`primitives/CustomDatePatternInput.tsx`): segmented preset
// toggle row + free-text custom input + pattern-validity signal. The
// primitive is mounted by both this card and the column-side
// `DateColumnCard` so polish-passes apply once.
//
// Preset commits: this card supplies the FORMAT_DATE_PRESETS enum
// values verbatim as the preset patterns: the AST distinguishes
// preset (enum branch) from custom (string branch) and downstream
// consumers (wire emitter, type checker) read the discriminator.
// The column-side commits wire-form patterns instead since its
// schema flattens the union to one validated string.
//
// The pattern is written out or calculated (`patternSourceModel.ts`). A
// calculated one is refused wherever Nova's case store works the value out
// (`format-date-pattern-not-fixed`: a profile with a Postgres target), so
// the menu disables it there with that reason.
//
// Type-checker rules (per `checkExpression`'s `case "format-date":`):
// the `date` operand must resolve to `date` or `datetime`. Errors
// land at `[..., "date"]`. Result type is always `text`.

"use client";

import {
	DATE_FORMAT_PRESET_DEFINITIONS,
	resolveCommCareDatePattern,
} from "@/lib/domain";
import type { ExpressionOfKind } from "@/lib/domain/expression";
import {
	dateOperandConstraint,
	type Expression,
	FORMAT_DATE_PRESETS,
	formatDate,
	type SlotConstraint,
	today,
} from "@/lib/domain/expression";
import { usePredicateEditContext } from "../../editorContext";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import {
	calculatedPatternSeed,
	type PatternPresets,
	patternSourceAdmission,
	patternSourceOf,
	storedPattern,
	textPatternFor,
} from "../../patternSourceModel";
import {
	CustomDatePatternInput,
	type DatePatternPreset,
} from "../../primitives/CustomDatePatternInput";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";
import { PatternSourceMenu } from "../../primitives/PatternSourceMenu";

/** The `date` operand resolves to date or datetime: module-const for
 *  a stable identity across renders. */
const DATE_CONSTRAINT = dateOperandConstraint();

/**
 * Preset table for the format-date AST. Each preset commits the
 * enum value verbatim (`"short"` / `"long"` / `"iso"`): the AST
 * keeps the preset-vs-custom distinction at the discriminator
 * level, and the wire emitter reads it.
 */
const FORMAT_DATE_PRESET_TABLE: readonly DatePatternPreset[] =
	FORMAT_DATE_PRESETS.map((preset) => ({
		id: preset,
		label: DATE_FORMAT_PRESET_DEFINITIONS[preset].label,
		pattern: preset,
	}));

/** A preset name written out is the preset; calculated, it is its text. */
const PRESETS: PatternPresets = { presetNames: FORMAT_DATE_PRESETS };

/** A calculated date style is read as text; every value can be. */
const PATTERN_TEXT_CONSTRAINT: SlotConstraint = { accepts: "any" };

/** Default: `format-date(today(), "short")`. The seed is a clean
 *  formatted date; the type checker validates the date operand and
 *  the result type resolves to text. */
export function formatDateDefault(
	_ctx: ExpressionEditContext,
): ExpressionOfKind<"format-date"> {
	return formatDate(today(), "short");
}

interface FormatDateCardProps {
	readonly value: ExpressionOfKind<"format-date">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function FormatDateCard({ value, onChange, path }: FormatDateCardProps) {
	const ctx = usePredicateEditContext();
	// Date-operand errors render via the `ExpressionPicker` shell's
	// `CardShell` footer at `[..., "date"]`; no parallel
	// `<InlineError>` is needed here.
	const source = patternSourceOf(value.pattern);
	const writtenText =
		typeof value.pattern === "string"
			? value.pattern
			: textPatternFor(value.pattern, "short", PRESETS).text;
	const candidates = {
		text: formatDate(value.date, writtenText),
		// A preset carries as the exact format it stands for, so the
		// calculation starts out writing the same text.
		calculated: formatDate(
			value.date,
			typeof value.pattern === "string"
				? calculatedPatternSeed(resolveCommCareDatePattern(value.pattern))
				: value.pattern,
		),
	};
	const admission = patternSourceAdmission(
		source,
		candidates,
		ctx.admitExpressionChange === undefined
			? undefined
			: (candidate) =>
					ctx.admitExpressionChange?.(path, candidate) ?? { admitted: true },
	);

	const setDate = (next: Expression) => {
		onChange(formatDate(next, value.pattern));
	};

	const setPattern = (next: string | Expression) => {
		onChange(formatDate(value.date, next));
	};

	return (
		<div className="space-y-3">
			<div>
				<div className="mb-1.5 text-[13px] font-medium text-nova-text-secondary">
					Date to format
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
				<div className="text-[13px] font-medium text-nova-text-secondary">
					Date style
				</div>
				<PatternSourceMenu
					label="Date style"
					source={source}
					admission={admission}
					replaces={(next) =>
						next === "text" &&
						typeof value.pattern !== "string" &&
						textPatternFor(value.pattern, "short", PRESETS).losesCalculation
							? "the calculated date style"
							: undefined
					}
					onSelect={(next) => onChange(candidates[next])}
				/>
				{typeof value.pattern === "string" ? (
					<CustomDatePatternInput
						value={value.pattern}
						onChange={setPattern}
						presets={FORMAT_DATE_PRESET_TABLE}
					/>
				) : (
					<>
						<ExpressionPicker
							value={value.pattern}
							onChange={(next) => setPattern(storedPattern(next, PRESETS))}
							path={appendSlot(path, "pattern")}
							constraint={PATTERN_TEXT_CONSTRAINT}
							variant="nested"
						/>
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Worked out as text when the app runs, then used as the date
							format, such as %d/%m/%Y
						</p>
					</>
				)}
			</div>
		</div>
	);
}
