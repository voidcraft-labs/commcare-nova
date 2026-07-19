// components/builder/inspector/inspectorChrome.tsx
//
// The shared chrome every right-rail inspector body is built from —
// the case-list/search bodies and the form-field inspector alike.
// One place owns the rail's sizing and voice so every editor feels
// like the same calm, approachable surface: readable labels, recessed
// input wells, generous spacing, and full-size targets. Every
// interactive control in the rail is at least 44px tall.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { Switch } from "@/components/shadcn/switch";

/** Full-width picker trigger — the recessed well every dropdown in
 *  the rail uses. Pair with `CONSOLE_MENU_ITEM_CLS` for the items. */
export const CONSOLE_TRIGGER_CLS =
	"group w-full flex items-center gap-2.5 px-3 py-2.5 min-h-11 text-[14px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30";

/** Menu item sizing for the rail's pickers — full-size targets even
 *  for single-line items. */
export const CONSOLE_MENU_ITEM_MIN = "min-h-11 text-[14px]";

/** The friendly label that titles a single control inside a section.
 *  Sentence case and ordinary type keep configuration readable instead
 *  of making common choices feel like technical instrumentation. */
export const INSPECTOR_LABEL_CLS =
	"text-[13px] font-medium leading-5 text-nova-text-secondary";

/** The recessed single-line input well every text field in the rail uses.
 *  Pure `focus:` ring — for inputs that also carry a refusable state, build
 *  the focused class by hand (see EditableText) so a rejection border isn't
 *  overridden by the focus pseudo-class. */
export const INSPECTOR_INPUT_CLS =
	"w-full min-h-11 px-3 text-[14px] rounded-lg border border-white/[0.06] bg-nova-deep/50 text-nova-text placeholder:text-nova-text-muted focus:outline-none focus:ring-1 focus:border-nova-violet/40 focus:ring-nova-violet/30 transition-colors";

/**
 * One titled cluster of controls. The heading is deliberately plain-language
 * and readable; visual hierarchy comes from weight and spacing, not a
 * technical-looking all-caps treatment.
 */
export function InspectorSection({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="space-y-4 border-t border-nova-border pt-5 first:border-t-0 first:pt-0">
			<h3 className="text-[14px] font-semibold leading-5 text-nova-text">
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
		<p className="text-[13px] leading-5 text-nova-text-muted">{children}</p>
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
			className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border border-white/[0.04] bg-nova-deep/30 px-3 py-2.5 transition-colors hover:border-white/[0.08]"
		>
			<span className="flex-1 min-w-0">
				<span className="block text-[14px] leading-5 text-nova-text">
					{label}
				</span>
				{description !== undefined && (
					<span className="mt-0.5 block text-[13px] leading-5 text-nova-text-muted">
						{description}
					</span>
				)}
			</span>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</label>
	);
}

/**
 * The inspector's standard footer action for taking the inspected
 * thing out of the app — "Remove column", "Remove filter", "Remove
 * search field". Its persistent rose treatment communicates the cost before
 * hover; a later confirmation is an additional safeguard, not the first cue.
 * One shape across every body so removal always lives in the same place: last.
 */
export function RemoveRow({
	label,
	onClick,
	disabledReason,
}: {
	readonly label: string;
	readonly onClick: () => void;
	/** When present, keep the destructive action visible but unavailable and
	 * explain which prerequisite protects the document. */
	readonly disabledReason?: string;
}) {
	const reasonId = useId();
	return (
		<div className="border-t border-nova-border pt-4">
			<Button
				type="button"
				variant="destructive"
				size="xl"
				onClick={onClick}
				disabled={disabledReason !== undefined}
				aria-describedby={disabledReason === undefined ? undefined : reasonId}
				className="w-full rounded-lg px-3 text-[14px]"
			>
				<Icon icon={tablerTrash} width="14" height="14" />
				<span>{label}</span>
			</Button>
			{disabledReason !== undefined && (
				<p
					id={reasonId}
					className="mt-2.5 text-[13px] leading-5 text-nova-text-muted"
				>
					{disabledReason}
				</p>
			)}
		</div>
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
					<Button
						key={opt.value}
						type="button"
						variant="ghost"
						size="xl"
						onClick={() => onChange(opt.value)}
						aria-pressed={active}
						className={`min-w-0 flex-1 rounded-md px-2 text-[14px] active:translate-y-0 ${
							active
								? "bg-nova-violet/[0.18] text-nova-violet-bright font-medium shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
								: "text-nova-text-muted not-disabled:hover:bg-white/[0.04] not-disabled:hover:text-nova-text dark:not-disabled:hover:bg-white/[0.04]"
						}`}
					>
						{opt.label}
					</Button>
				);
			})}
		</fieldset>
	);
}
