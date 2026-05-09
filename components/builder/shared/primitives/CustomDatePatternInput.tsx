// components/builder/case-list-config/primitives/CustomDatePatternInput.tsx
//
// Shared "preset row + custom CCHQ date pattern input" primitive.
// Mounted by both `cards/expression/FormatDateCard.tsx` (the
// `format-date` ValueExpression — `pattern` accepts the closed
// preset enum OR an arbitrary CCHQ wire pattern) and
// `cards/column/DateColumnCard.tsx` (the `date` Column kind —
// `pattern` accepts any non-empty string).
//
// Both consumers drive the same CCHQ format-date runtime; the
// primitive owns:
//   - Segmented preset toggle row (caller-supplied preset table).
//   - Free-text custom input shown when no preset matches.
//   - Empty-pattern signal — `aria-invalid` + visible red border +
//     inline error message + refused commit. The schema layer
//     rejects empty patterns (`z.string().min(1)` on both
//     `formatDateSchema.pattern` and `dateColumnSchema.pattern`);
//     this primitive surfaces the rejection inline so users see it
//     before save, not as a deferred parse failure at the
//     persistence boundary.
//
// Why one primitive: the two cards' previous near-duplicates were
// drifting structurally. A polish-pass added the empty-pattern
// signal to one and not the other, leaving column-side authors
// able to commit a silently-empty pattern that rendered the raw
// ISO string at the wire boundary. Sharing the surface makes that
// drift impossible.

"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One preset entry in the segmented toggle row. `id` is the
 * stable key (the React key + the preset enum value when the
 * caller commits a closed-enum preset); `label` is the visible
 * button text; `pattern` is the wire-form value committed when
 * the preset is selected.
 *
 * The two consumers commit different shapes — `FormatDateCard`
 * commits the preset enum value verbatim (`"short"` / `"long"` /
 * `"iso"`) so the AST distinguishes preset from custom; the
 * column-side `DateColumnCard` commits the wire pattern
 * (`"%Y-%m-%d"` for ISO) since its schema flattens the union to
 * `z.string().min(1)`. The primitive doesn't impose a choice —
 * each consumer supplies its own table.
 */
export interface DatePatternPreset {
	readonly id: string;
	readonly label: string;
	readonly pattern: string;
}

interface CustomDatePatternInputProps {
	/** Current pattern value. */
	readonly value: string;
	/** Fired when the user commits a new pattern (preset click or
	 *  custom-input blur with a non-empty draft). Empty-string
	 *  drafts are refused at the primitive boundary so the AST
	 *  stays parse-clean against the schema's `min(1)` constraint. */
	readonly onChange: (next: string) => void;
	/** Caller-supplied preset table. Each entry's `pattern` is
	 *  what gets committed when the user clicks the preset button;
	 *  active state highlights when the current `value` matches an
	 *  entry's pattern verbatim. */
	readonly presets: readonly DatePatternPreset[];
	/**
	 * Pattern to seed the custom input with when the user clicks
	 * the "Custom" affordance from a preset state. Must be a real
	 * CCHQ pattern (e.g. `%d-%b-%Y`) — seeding with a placeholder
	 * literal would leak that string into the wire output. The
	 * default of `%d-%b-%Y` produces `27-Apr-2025` at the runtime
	 * boundary.
	 */
	readonly customSeed?: string;
}

/**
 * Preset-row + custom-input pair driving a CCHQ format-date
 * pattern slot. Owns the full UX for the slot — both consumers
 * mount it and forward the user's commit through their own
 * AST-rebuild path.
 */
export function CustomDatePatternInput({
	value,
	onChange,
	presets,
	customSeed = "%d-%b-%Y",
}: CustomDatePatternInputProps) {
	const presetPatterns = new Set(presets.map((p) => p.pattern));
	const isPreset = presetPatterns.has(value);
	return (
		<div className="space-y-1.5">
			<PresetRow
				value={value}
				onChange={onChange}
				presets={presets}
				isPreset={isPreset}
				customSeed={customSeed}
			/>
			{!isPreset && <CustomInput value={value} onChange={onChange} />}
		</div>
	);
}

interface PresetRowProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly presets: readonly DatePatternPreset[];
	readonly isPreset: boolean;
	readonly customSeed: string;
}

/**
 * Segmented preset toggle. Each preset commits its `pattern`
 * verbatim; the trailing "Custom" button switches to the
 * free-text branch by committing the `customSeed` value (a real
 * CCHQ pattern), so the user can edit a meaningful starting
 * string rather than a placeholder.
 *
 * The fieldset element carries the implicit "group of related
 * controls" role without an explicit `role="group"` attribute;
 * `aria-label` decorates without adding a structural heading the
 * surrounding sub-section header already provides.
 */
function PresetRow({
	value,
	onChange,
	presets,
	isPreset,
	customSeed,
}: PresetRowProps) {
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
			{presets.map((preset) => {
				const isActive = isPreset && value === preset.pattern;
				return (
					<button
						type="button"
						key={preset.id}
						onClick={() => onChange(preset.pattern)}
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
					// Switching from preset → custom seeds with a real
					// CCHQ pattern so the wire emitter renders a useful
					// value if the author saves without further editing.
					// The `customSeed` is constrained to a real pattern at
					// the prop type — no placeholder literal can leak into
					// the wire output.
					if (isPreset) onChange(customSeed);
				}}
				className={`${baseCls} ${!isPreset ? activeCls : idleCls} ml-auto`}
				aria-pressed={!isPreset}
			>
				Custom
			</button>
		</fieldset>
	);
}

interface CustomInputProps {
	readonly value: string;
	readonly onChange: (next: string) => void;
}

/**
 * Free-text CCHQ pattern input. Commits on blur. Empty draft is
 * refused at commit time — the schema (`z.string().min(1)`)
 * rejects empty patterns at parse, but the type checker does NOT
 * surface that rejection at the validity-index layer, so without
 * this primitive's local gate an empty input would flow silently
 * through the editor and surface only at the save-boundary parse.
 *
 * Local validity state: track whether the draft would parse,
 * drive `aria-invalid` and a visible error border + inline hint
 * off it, and refuse the empty-string commit. The user's empty
 * draft persists locally until they fix it; the next keystroke
 * clears the error signal so the visual state matches the live
 * input.
 */
function CustomInput({ value, onChange }: CustomInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = value;
	const [draft, setDraft] = useState(initial);
	const [showEmptyError, setShowEmptyError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowEmptyError(false);
		}
	}, [initial, draft]);
	const commit = useCallback(() => {
		if (draft.trim() === "") {
			// Empty draft — surface the schema's `min(1)` rejection
			// inline and refuse the emit. The user sees the message +
			// red border; the next keystroke clears the error per the
			// onChange handler below.
			setShowEmptyError(true);
			return;
		}
		setShowEmptyError(false);
		if (draft === initial) return;
		onChange(draft);
	}, [draft, initial, onChange]);
	const isInvalid = showEmptyError;
	const cls = [
		"w-full px-2 py-1.5 text-xs rounded-md border bg-nova-deep/50 text-nova-text font-mono placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 transition-colors",
		isInvalid
			? "border-nova-error/40 focus:border-nova-error/60 focus:ring-nova-error/30"
			: "border-white/[0.06] focus:border-nova-violet/40 focus:ring-nova-violet/30",
	].join(" ");
	return (
		<div className="space-y-1">
			<input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					if (showEmptyError && e.target.value.trim() !== "") {
						setShowEmptyError(false);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				placeholder="CCHQ format-date pattern (e.g. %d-%b-%Y)"
				aria-label="Custom date pattern"
				aria-invalid={isInvalid || undefined}
				className={cls}
			/>
			{isInvalid && (
				<div className="text-[11px] leading-snug text-nova-error/90">
					Custom pattern cannot be empty.
				</div>
			)}
		</div>
	);
}
