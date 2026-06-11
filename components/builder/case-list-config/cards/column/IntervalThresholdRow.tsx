// components/builder/case-list-config/cards/column/IntervalThresholdRow.tsx
//
// Shared `(threshold, unit)` editor row for `interval` columns. The
// numeric threshold input + unit dropdown live here so the card
// body (`IntervalCard`) focuses on the per-display extras — the
// `display` segmented toggle and the `text` slot whose label flips
// between "decoration" and "flag text" — rather than re-implementing
// the threshold-plus-unit pair inline.
//
// `TimeSinceUnit` is a closed enum (`days` / `weeks` / `months` /
// `years`) declared on `lib/domain/modules.ts`; the dropdown reads
// from its source-of-truth tuple. The numeric input commits on blur
// with the same draft / commit pattern as `LiteralValueInput`'s
// `NumericInput`.

"use client";
import { Menu } from "@base-ui/react/menu";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TIME_SINCE_UNITS, type TimeSinceUnit } from "@/lib/domain";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

/**
 * Per-unit display label. The `Record<TimeSinceUnit, string>` shape
 * forces an entry for every variant — adding `"hours"` to
 * `TIME_SINCE_UNITS` (the source of truth in
 * `lib/domain/modules.ts`) breaks the build here until a label
 * lands. The dropdown options below iterate `TIME_SINCE_UNITS`
 * directly so the new variant flows into the picker without a
 * parallel edit.
 */
const UNIT_LABELS: Record<TimeSinceUnit, string> = {
	days: "Days",
	weeks: "Weeks",
	months: "Months",
	years: "Years",
};

interface IntervalThresholdRowProps {
	readonly threshold: number;
	readonly onThresholdChange: (next: number) => void;
	readonly unit: TimeSinceUnit;
	readonly onUnitChange: (next: TimeSinceUnit) => void;
	/** Display label for the threshold input (e.g. "Threshold",
	 *  "Late after"). */
	readonly thresholdLabel: string;
}

/**
 * Threshold (numeric) + unit (closed enum) pair. The numeric
 * input commits on blur; the unit dropdown commits on click.
 */
export function IntervalThresholdRow({
	threshold,
	onThresholdChange,
	unit,
	onUnitChange,
	thresholdLabel,
}: IntervalThresholdRowProps) {
	return (
		<div className="grid grid-cols-[1fr_auto] gap-2 items-start">
			<div>
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
					{thresholdLabel}
				</div>
				<ThresholdInput value={threshold} onChange={onThresholdChange} />
			</div>
			<div>
				<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted mb-1.5">
					Unit
				</div>
				<UnitMenu unit={unit} onUnitChange={onUnitChange} />
			</div>
		</div>
	);
}

interface ThresholdInputProps {
	readonly value: number;
	readonly onChange: (next: number) => void;
}

/**
 * Numeric threshold input. Same draft / commit pattern as
 * `LiteralValueInput`'s `NumericInput` — local draft holds the
 * in-flight edit, commits on blur, re-syncs to the external value
 * when the input isn't focused. NaN parses are refused so the AST
 * never carries a non-finite threshold.
 */
function ThresholdInput({ value, onChange }: ThresholdInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const initial = String(value);
	const [draft, setDraft] = useState(initial);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
		}
	}, [initial, draft]);
	const commit = useCallback(() => {
		if (draft === initial) return;
		const parsed = Number.parseInt(draft, 10);
		if (Number.isNaN(parsed)) {
			// Refuse the commit; reset the draft so the input matches
			// the persisted value. The user sees their non-numeric
			// input vanish — a stronger signal than a silent revert
			// would produce, since the number-typed input UI in modern
			// browsers already constrains keyboard entry.
			setDraft(initial);
			return;
		}
		onChange(parsed);
	}, [draft, initial, onChange]);
	return (
		<input
			ref={inputRef}
			type="number"
			step={1}
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			autoComplete="off"
			data-1p-ignore
			aria-label="Threshold"
			className="w-full px-2 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-text font-mono placeholder:text-nova-text-muted/60 focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors"
		/>
	);
}

interface UnitMenuProps {
	readonly unit: TimeSinceUnit;
	readonly onUnitChange: (next: TimeSinceUnit) => void;
}

/**
 * Closed-enum unit dropdown. Mirrors `DateAddCard`'s
 * `IntervalMenu` shape; same Base UI Menu primitive, same active-
 * row styling, same corner-rounding pattern.
 */
function UnitMenu({ unit, onUnitChange }: UnitMenuProps) {
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`Unit: ${UNIT_LABELS[unit]}`}
				className="group flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-white/[0.06] bg-nova-deep/50 text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
			>
				<span>{UNIT_LABELS[unit]}</span>
				<svg
					aria-hidden="true"
					width="10"
					height="10"
					viewBox="0 0 10 10"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				>
					<path
						d="M2 3.5L5 6.5L8 3.5"
						stroke="currentColor"
						strokeWidth="1.2"
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
				>
					<Menu.Popup className={MENU_POPUP_CLS}>
						{TIME_SINCE_UNITS.map((u, i) => {
							const isActive = u === unit;
							const last = TIME_SINCE_UNITS.length - 1;
							const corners =
								i === 0 && i === last
									? "rounded-xl"
									: i === 0
										? "rounded-t-xl"
										: i === last
											? "rounded-b-xl"
											: "";
							return (
								<Menu.Item
									key={u}
									onClick={() => onUnitChange(u)}
									className={`${corners} ${MENU_ITEM_CLS} ${
										isActive ? "text-nova-violet-bright bg-nova-violet/10" : ""
									}`}
								>
									<span>{UNIT_LABELS[u]}</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
