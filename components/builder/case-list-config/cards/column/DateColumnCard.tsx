// components/builder/case-list-config/cards/column/DateColumnCard.tsx
//
// Renders the `date` Column kind — formats a date / datetime
// property through a CCHQ format-date pattern.
//
// Slots:
//   - `field` — case-property name. Filtered to `date` /
//     `datetime` typed properties.
//   - `header` — column display label.
//   - `pattern` — the CCHQ wire-form date pattern. The card
//     surfaces three named presets (Short / Long / ISO) plus a
//     Custom branch for free-form CCHQ pattern strings; the saved
//     pattern is verbatim across all four routes so a non-preset
//     authored pattern round-trips through the editor untouched.
//
// Why three presets: matches CCHQ's `format-date` value function's
// preset tier (`short` / `long` / `iso`) — the runtime formatter
// recognizes the bare names AND admits an arbitrary pattern
// string. The card lets authors pick the common shapes without
// memorizing pattern syntax, and falls through to a free-text
// input for anything else.

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CaseProperty, Column } from "@/lib/domain";
import { dateColumn } from "@/lib/domain";
import type { ColumnEditContext } from "../../columnEditorSchemas";
import { ColumnFieldRow } from "./ColumnFieldRow";

const DATE_DATA_TYPES = new Set<string>(["date", "datetime"]);

/** Property-type filter — date / datetime only. */
function isDateTyped(p: CaseProperty): boolean {
	return DATE_DATA_TYPES.has(p.data_type ?? "text");
}

/**
 * Named preset patterns surfaced as toggle buttons. The label
 * strings are CCHQ's canonical names (recognized verbatim by the
 * runtime formatter); the matching pattern strings are the wire
 * forms each preset compiles to in CommCare's format-date
 * implementation.
 */
const PRESETS: readonly {
	id: "short" | "long" | "iso";
	label: string;
	pattern: string;
}[] = [
	{ id: "short", label: "Short", pattern: "short" },
	{ id: "long", label: "Long", pattern: "long" },
	{ id: "iso", label: "ISO", pattern: "%Y-%m-%d" },
];

const PRESET_PATTERNS = new Set(PRESETS.map((p) => p.pattern));

interface DateColumnCardProps {
	readonly value: Extract<Column, { kind: "date" }>;
	readonly onChange: (next: Column) => void;
	readonly ctx: ColumnEditContext;
	readonly errors?: readonly string[];
}

export function DateColumnCard({
	value,
	onChange,
	errors,
}: DateColumnCardProps) {
	const setField = (next: string) =>
		onChange(dateColumn(next, value.header, value.pattern));
	const setHeader = (next: string) =>
		onChange(dateColumn(value.field, next, value.pattern));
	const setPattern = (next: string) =>
		onChange(dateColumn(value.field, value.header, next));

	const isPreset = PRESET_PATTERNS.has(value.pattern);

	return (
		<div className="space-y-2">
			<ColumnFieldRow
				field={value.field}
				onFieldChange={setField}
				header={value.header}
				onHeaderChange={setHeader}
				propertyFilter={isDateTyped}
				errors={errors}
			/>
			<div className="space-y-1.5">
				<div className="text-[10px] text-nova-text-muted/70 uppercase tracking-wider">
					Pattern
				</div>
				<PresetRow pattern={value.pattern} onPatternChange={setPattern} />
				{!isPreset && (
					<CustomPatternInput value={value.pattern} onChange={setPattern} />
				)}
			</div>
		</div>
	);
}

interface PresetRowProps {
	readonly pattern: string;
	readonly onPatternChange: (next: string) => void;
}

/**
 * Segmented preset selector. Active state highlights the matching
 * preset; the trailing "Custom" button switches to the free-text
 * branch and seeds with a meaningful CCHQ pattern (`%d-%b-%Y`)
 * rather than an empty string — the schema admits empty patterns
 * but the wire formatter would render the property's raw ISO
 * string for an empty pattern, defeating the column's purpose.
 */
function PresetRow({ pattern, onPatternChange }: PresetRowProps) {
	const isPreset = PRESET_PATTERNS.has(pattern);
	const baseCls =
		"px-2 py-1.5 text-[11px] uppercase tracking-wider transition-colors cursor-pointer rounded-md";
	const activeCls = "text-nova-violet-bright bg-nova-violet/10";
	const idleCls =
		"text-nova-text-muted hover:text-nova-text hover:bg-white/[0.04]";
	return (
		<fieldset
			className="flex gap-1 px-1 py-1 rounded-md border border-white/[0.06] bg-nova-deep/50"
			aria-label="Date pattern preset"
		>
			{PRESETS.map((preset) => {
				const isActive = isPreset && pattern === preset.pattern;
				return (
					<button
						type="button"
						key={preset.id}
						onClick={() => onPatternChange(preset.pattern)}
						className={`${baseCls} ${isActive ? activeCls : idleCls}`}
						aria-pressed={isActive}
					>
						{preset.label}
					</button>
				);
			})}
			<button
				type="button"
				onClick={() => {
					// Switch to custom: seed with a meaningful CCHQ pattern
					// (`%d-%b-%Y` → `27-Apr-2025`) so the wire formatter
					// renders a useful value if the user saves without
					// further editing. Mirrors the preset-to-custom
					// transition in `FormatDateCard`.
					if (isPreset) onPatternChange("%d-%b-%Y");
				}}
				className={`${baseCls} ${!isPreset ? activeCls : idleCls} ml-auto`}
				aria-pressed={!isPreset}
			>
				Custom
			</button>
		</fieldset>
	);
}

interface CustomPatternInputProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * Free-text CCHQ pattern input. Commits on blur. The schema
 * (`dateColumnSchema.pattern: z.string()`) admits empty strings,
 * so no client-side rejection — but the runtime formatter would
 * render the raw ISO string for empty patterns, so the input's
 * placeholder hints at the canonical CCHQ format string.
 */
function CustomPatternInput({ value, onChange }: CustomPatternInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(value);
	useEffect(() => {
		if (value !== draft && document.activeElement !== inputRef.current) {
			setDraft(value);
		}
	}, [value, draft]);
	const commit = useCallback(() => {
		if (draft === value) return;
		onChange(draft);
	}, [draft, value, onChange]);
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
