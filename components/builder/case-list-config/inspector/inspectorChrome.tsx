// components/builder/case-list-config/inspector/inspectorChrome.tsx
//
// The console chrome the case-list inspector bodies are built from.
// One place owns the rail's sizing and voice so every editor reads
// the same way: etched mono section labels, recessed input wells,
// generous calm spacing, and full-size targets — every interactive
// control in the rail is at least 44px tall.

"use client";
import { useId } from "react";
import { Switch } from "@/components/shadcn/switch";

/** Full-width picker trigger — the recessed well every dropdown in
 *  the rail uses. Pair with `CONSOLE_MENU_ITEM_CLS` for the items. */
export const CONSOLE_TRIGGER_CLS =
	"group w-full flex items-center gap-2.5 px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30";

/** Menu item sizing for the rail's pickers — full-size targets even
 *  for single-line items. */
export const CONSOLE_MENU_ITEM_MIN = "min-h-11";

/**
 * One titled cluster of controls. The etched label is console
 * instrumentation — mono, uppercase, wide tracking — and the body
 * below it breathes.
 */
export function InspectorSection({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="pt-4 first:pt-0 border-t border-nova-border first:border-t-0 space-y-2.5">
			<h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-nova-text-muted">
				{label}
			</h3>
			{children}
		</section>
	);
}

/** Quiet explanatory line under a control. */
export function InspectorHint({
	children,
}: {
	readonly children: React.ReactNode;
}) {
	return (
		<p className="text-[11px] leading-relaxed text-nova-text-muted">
			{children}
		</p>
	);
}

/**
 * Labeled on/off row — the label and its meaning are always visible,
 * the switch carries the state. The whole row toggles, so the target
 * is the full rail width, never just the switch.
 */
export function ToggleRow({
	label,
	description,
	checked,
	onChange,
}: {
	readonly label: string;
	readonly description?: string;
	readonly checked: boolean;
	readonly onChange: (next: boolean) => void;
}) {
	const id = useId();
	return (
		<label
			htmlFor={id}
			className="flex items-center gap-3 w-full min-h-11 px-3 py-2 rounded-lg border border-white/[0.04] bg-nova-deep/30 cursor-pointer hover:border-white/[0.08] transition-colors"
		>
			<span className="flex-1 min-w-0">
				<span className="block text-[13px] text-nova-text">{label}</span>
				{description !== undefined && (
					<span className="block text-[11px] text-nova-text-muted leading-snug">
						{description}
					</span>
				)}
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

/**
 * Labeled segmented control — every option visible, every option a
 * full-size target. Use for short mutually-exclusive choices where a
 * dropdown would hide the alternatives.
 */
export function SegmentedRow<T extends string>({
	legend,
	options,
	value,
	onChange,
}: {
	/** Accessible name for the group (visually the section label
	 *  above already names it). */
	readonly legend: string;
	readonly options: ReadonlyArray<{
		readonly value: T;
		readonly label: string;
	}>;
	readonly value: T;
	readonly onChange: (next: T) => void;
}) {
	return (
		<fieldset className="flex w-full gap-1 p-1 rounded-lg border border-white/[0.06] bg-nova-deep/50 m-0">
			<legend className="sr-only">{legend}</legend>
			{options.map((opt) => {
				const active = opt.value === value;
				return (
					<button
						key={opt.value}
						type="button"
						onClick={() => onChange(opt.value)}
						aria-pressed={active}
						className={`flex-1 min-h-11 px-2 text-[13px] rounded-md transition-colors cursor-pointer ${
							active
								? "bg-nova-violet/[0.18] text-nova-violet-bright font-medium shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
								: "text-nova-text-muted hover:text-nova-text hover:bg-white/[0.04]"
						}`}
					>
						{opt.label}
					</button>
				);
			})}
		</fieldset>
	);
}
