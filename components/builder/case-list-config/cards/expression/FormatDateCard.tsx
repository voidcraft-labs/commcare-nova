// components/builder/case-list-config/cards/expression/FormatDateCard.tsx
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
// surfaces as a segmented presets row + a free-text input. The
// preset row commits the matching enum value; the free-text input
// commits any non-empty string. When the saved pattern matches an
// enum value, the preset row marks it active; otherwise the free-
// text input shows the custom string and the preset row reads as
// "Custom".
//
// Type-checker rules (per `checkExpression`'s `case "format-date":`):
// the `date` operand must resolve to `date` or `datetime`. Errors
// land at `[..., "date"]`. Result type is always `text`.

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	FORMAT_DATE_PRESETS,
	type FormatDatePreset,
	formatDate,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import { appendSlot, type EditorPath } from "../../path";
import { ExpressionPicker } from "../../primitives/ExpressionPicker";

const PRESET_LABELS: Record<FormatDatePreset, string> = {
	short: "Short",
	long: "Long",
	iso: "ISO",
};

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

	const setPattern = (next: FormatDatePreset | string) => {
		onChange(formatDate(value.date, next));
	};

	// Classify the current pattern — enum branch vs custom string —
	// so the UI surfaces the right active state.
	const isPreset = (FORMAT_DATE_PRESETS as readonly string[]).includes(
		value.pattern,
	);

	return (
		<div className="space-y-2">
			<div>
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider mb-1">
					Date / datetime
				</div>
				<ExpressionPicker
					value={value.date}
					onChange={setDate}
					path={appendSlot(path, "date")}
					expectedType="date"
					variant="nested"
				/>
			</div>

			<div className="space-y-1.5">
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
					Pattern
				</div>
				<PresetRow pattern={value.pattern} setPattern={setPattern} />
				{!isPreset && (
					<CustomPatternInput value={value.pattern} onChange={setPattern} />
				)}
			</div>
		</div>
	);
}

interface PresetRowProps {
	readonly pattern: FormatDatePreset | string;
	readonly setPattern: (next: FormatDatePreset | string) => void;
}

/** Segmented preset selector + a "Custom" affordance. Each preset
 *  commits the matching enum value verbatim through the schema's
 *  `pattern` union; "Custom" commits an empty string and reveals
 *  the free-text input below. */
function PresetRow({ pattern, setPattern }: PresetRowProps) {
	const isPreset = (FORMAT_DATE_PRESETS as readonly string[]).includes(pattern);
	const baseCls =
		"px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors cursor-pointer rounded-md";
	const activeCls = "text-nova-violet-bright bg-nova-violet/10";
	const idleCls =
		"text-nova-text-muted hover:text-nova-text hover:bg-white/[0.04]";
	// `<fieldset>` carries the implicit "group of related controls"
	// role without an explicit `role="group"` attribute — biome's
	// `useSemanticElements` rule prefers the semantic element. The
	// visible-label decoration uses `aria-label` rather than a
	// `<legend>` because the surrounding "Pattern" sub-section header
	// already labels the group; a redundant legend would add a
	// structural heading the screen reader doesn't need.
	return (
		<fieldset
			className="flex gap-1 px-1 py-1 rounded-md border border-white/[0.06] bg-nova-deep/50"
			aria-label="Date pattern preset"
		>
			{FORMAT_DATE_PRESETS.map((preset) => {
				const isActive = isPreset && pattern === preset;
				return (
					<button
						type="button"
						key={preset}
						onClick={() => setPattern(preset)}
						className={`${baseCls} ${isActive ? activeCls : idleCls}`}
						aria-pressed={isActive}
					>
						{PRESET_LABELS[preset]}
					</button>
				);
			})}
			<button
				type="button"
				onClick={() => {
					// Switching from preset → custom seeds a non-empty
					// placeholder so the schema's `z.string().min(1)` branch
					// admits the value; authors flip the input to a real
					// CCHQ pattern string.
					if (isPreset) setPattern("custom-pattern");
				}}
				className={`${baseCls} ${!isPreset ? activeCls : idleCls} ml-auto`}
				aria-pressed={!isPreset}
			>
				Custom
			</button>
		</fieldset>
	);
}

/** Free-text custom pattern input. Commits on blur. The schema
 *  rejects empty patterns via `z.string().min(1)`, so the editor
 *  surfaces the type checker's verdict (or a parse-time rejection
 *  at save) when the user clears the field. */
function CustomPatternInput({
	value,
	onChange,
}: {
	readonly value: string;
	readonly onChange: (next: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = value;
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	const commit = useCallback(() => {
		// Refuse the empty-string commit — the schema rejects it. Roll
		// back the draft so the input doesn't visually clear.
		if (draft.trim() === "") {
			setDraft(initial);
			return;
		}
		onChange(draft);
	}, [draft, initial, onChange]);
	return (
		<input
			ref={inputRef}
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			placeholder="CCHQ format-date pattern (e.g. %d-%b-%Y)"
			aria-label="Custom date pattern"
			className="w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text font-mono placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
		/>
	);
}
