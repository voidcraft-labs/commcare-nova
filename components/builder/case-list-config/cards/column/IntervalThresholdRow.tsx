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
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { FieldError } from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { TIME_SINCE_UNITS, type TimeSinceUnit } from "@/lib/domain";

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
	const thresholdId = useId();
	const unitId = useId();
	return (
		<div className="grid grid-cols-[1fr_auto] items-start gap-3">
			<div>
				<label
					htmlFor={thresholdId}
					className={`mb-2 block ${INSPECTOR_LABEL_CLS}`}
				>
					{thresholdLabel}
				</label>
				<ThresholdInput
					id={thresholdId}
					value={threshold}
					onChange={onThresholdChange}
				/>
			</div>
			<div>
				<label htmlFor={unitId} className={`mb-2 block ${INSPECTOR_LABEL_CLS}`}>
					Unit
				</label>
				<UnitMenu triggerId={unitId} unit={unit} onUnitChange={onUnitChange} />
			</div>
		</div>
	);
}

interface ThresholdInputProps {
	readonly id: string;
	readonly value: number;
	readonly onChange: (next: number) => void;
}

/**
 * Numeric threshold input. Local draft state preserves incomplete
 * and invalid edits so the author can correct them in place. Blur
 * commits only a finite, positive whole number — exactly the domain
 * schema's `int().positive()` contract — and otherwise exposes a
 * friendly inline action without changing the document.
 */
function ThresholdInput({ id, value, onChange }: ThresholdInputProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const errorId = `${id}-error`;
	const initial = String(value);
	const [draft, setDraft] = useState(initial);
	const [showError, setShowError] = useState(false);
	useEffect(() => {
		if (initial !== draft && document.activeElement !== inputRef.current) {
			setDraft(initial);
			setShowError(false);
		}
	}, [initial, draft]);
	const commit = useCallback(() => {
		if (draft === initial) {
			setShowError(false);
			return;
		}
		const parsed = positiveWholeNumber(draft);
		if (parsed === undefined) {
			setShowError(true);
			return;
		}
		setShowError(false);
		onChange(parsed);
	}, [draft, initial, onChange]);
	return (
		<div>
			<Input
				id={id}
				ref={inputRef}
				type="number"
				min={1}
				step={1}
				value={draft}
				onChange={(event) => {
					const next = event.target.value;
					setDraft(next);
					if (showError && positiveWholeNumber(next) !== undefined) {
						setShowError(false);
					}
				}}
				onBlur={commit}
				autoComplete="off"
				data-1p-ignore
				aria-invalid={showError || undefined}
				aria-describedby={showError ? errorId : undefined}
				className={`h-auto min-h-11 w-full border bg-nova-deep/50 px-3 text-[14px] text-nova-text placeholder:text-nova-text-muted focus-visible:ring-1 md:text-[14px] dark:bg-nova-deep/50 ${
					showError
						? "border-nova-rose/40 focus-visible:border-nova-rose/60 focus-visible:ring-nova-rose/30"
						: "border-white/[0.06] focus-visible:border-nova-violet/40 focus-visible:ring-nova-violet/30"
				}`}
			/>
			{showError ? (
				<FieldError
					id={errorId}
					className="mt-2 text-[13px] leading-5 text-nova-rose"
				>
					Enter a whole number greater than 0
				</FieldError>
			) : null}
		</div>
	);
}

function positiveWholeNumber(draft: string): number | undefined {
	if (draft.trim() === "") return undefined;
	const parsed = Number(draft);
	return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
		? parsed
		: undefined;
}

interface UnitMenuProps {
	readonly triggerId: string;
	readonly unit: TimeSinceUnit;
	readonly onUnitChange: (next: TimeSinceUnit) => void;
}

/**
 * Closed-enum unit dropdown using the shared Select primitive.
 */
function UnitMenu({ triggerId, unit, onUnitChange }: UnitMenuProps) {
	return (
		<Select
			value={unit}
			onValueChange={(next) => {
				if (next !== null && TIME_SINCE_UNITS.includes(next)) {
					onUnitChange(next);
				}
			}}
		>
			<SelectTrigger
				id={triggerId}
				className="h-auto min-h-11 gap-1.5 border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-[14px] text-nova-violet-bright not-disabled:hover:border-nova-violet/30 dark:bg-nova-deep/50 dark:not-disabled:hover:bg-nova-deep/50"
			>
				<SelectValue>{UNIT_LABELS[unit]}</SelectValue>
			</SelectTrigger>
			<SelectContent align="start">
				{TIME_SINCE_UNITS.map((nextUnit) => (
					<SelectItem
						key={nextUnit}
						value={nextUnit}
						className="min-h-11 text-[14px]"
					>
						{UNIT_LABELS[nextUnit]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
