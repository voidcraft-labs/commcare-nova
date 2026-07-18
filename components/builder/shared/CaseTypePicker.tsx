// components/builder/shared/CaseTypePicker.tsx
//
// Reusable "pick an existing case type or create a new one" surface. Two
// exports:
//   - `CaseTypePickerContent` — the inner list + create-new UI, embedded
//     inline by the add-module flow (no popover wrapper, so it nests cleanly
//     inside the module-creation popover).
//   - `CaseTypePicker` — a trigger button + its own popover wrapping the
//     content, used by module settings as a compact dropdown.
//
// Valid by construction: the create-new name is adjudicated live by
// `caseTypeNameVerdict` (the same wire identifier rules the commit gate
// enforces), so an illegal or duplicate name can't be committed — the Create
// control disables with the reason rather than letting the gate reject after.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { type Ref, useId, useMemo, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { caseTypeNameVerdict } from "@/lib/doc/identifierVerdicts";
import { humanizeId, slugifyId } from "@/lib/domain";

const ROW_BASE =
	"h-auto min-h-11 w-full justify-start gap-2 rounded-lg px-3 py-2.5 text-left text-sm whitespace-normal";

interface CaseTypeDisplay {
	readonly label: string;
	readonly needsDisambiguation: boolean;
}

/**
 * Case types are stored as identifiers but read as concepts in the builder.
 * Only legacy identifiers that collapse to the same friendly label need their
 * stored value exposed so a person can tell them apart.
 */
function caseTypeDisplays(
	names: readonly string[],
): ReadonlyMap<string, CaseTypeDisplay> {
	const labels = names.map((name) => ({ name, label: humanizeId(name) }));
	const labelCounts = new Map<string, number>();
	for (const { label } of labels) {
		const key = label.toLowerCase();
		labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
	}

	return new Map(
		labels.map(({ name, label }) => [
			name,
			{
				label,
				needsDisambiguation: (labelCounts.get(label.toLowerCase()) ?? 0) > 1,
			},
		]),
	);
}

function creationErrorMessage(
	verdict: ReturnType<typeof caseTypeNameVerdict>,
	candidate: string,
): string | null {
	if (verdict.ok) return null;

	switch (verdict.code) {
		case "empty":
			return "Use at least one letter or number";
		case "illegal_format":
			return "Start the name with a word, not a number";
		case "reserved":
			return `Choose a more specific name, such as ${humanizeId(candidate)} record`;
		case "too_long":
			return "Use a shorter name";
		case "duplicate":
			return `${humanizeId(candidate)} already exists. Choose it above.`;
	}
}

interface CaseTypePickerContentProps {
	/** The currently-bound case type, highlighted in the list. */
	readonly value?: string;
	/** Fired when a case type is chosen (existing) or created (new). */
	readonly onChange: (name: string) => void;
	/** When provided, a consequence-labeled removal row shows (settings only). */
	readonly onClear?: () => void;
}

/**
 * Inner list + create-new UI. Existing case types are pickable rows; the
 * bottom holds an inline "new case type" input that commits a validated name.
 */
export function CaseTypePickerContent({
	value,
	onChange,
	onClear,
}: CaseTypePickerContentProps) {
	const caseTypes = useCaseTypes();
	const [draft, setDraft] = useState("");
	const inputId = useId();
	const errorId = `${inputId}-error`;

	const existingNames = useMemo(
		() => new Set(caseTypes.map((c) => c.name)),
		[caseTypes],
	);
	const displays = useMemo(
		() => caseTypeDisplays(caseTypes.map((caseType) => caseType.name)),
		[caseTypes],
	);
	const candidate = useMemo(() => slugifyId(draft, ""), [draft]);
	const verdict = useMemo(
		() => caseTypeNameVerdict(candidate, existingNames),
		[candidate, existingNames],
	);
	// Only surface the reason once the user has typed something — an empty
	// field shouldn't read as an error before they start.
	const showError = draft.trim().length > 0 && !verdict.ok;

	const commitNew = () => {
		if (!verdict.ok) return;
		onChange(candidate);
		setDraft("");
	};

	return (
		<div className="flex max-h-[min(24rem,var(--available-height,24rem))] w-72 max-w-full flex-col p-1.5">
			<div className="shrink-0 px-2 pb-1.5 pt-1 text-xs font-medium text-nova-text-muted">
				Case types
			</div>

			{caseTypes.length === 0 ? (
				<div className="px-3 py-2 text-[13px] leading-relaxed text-nova-text-muted">
					<p>No case types yet</p>
					<p className="mt-0.5">Create one below</p>
				</div>
			) : (
				<div className="min-h-0 max-h-56 flex-1 overflow-y-auto overscroll-contain">
					{caseTypes.map((ct) => {
						const active = ct.name === value;
						const display = displays.get(ct.name) ?? {
							label: humanizeId(ct.name),
							needsDisambiguation: false,
						};
						return (
							<Button
								key={ct.name}
								type="button"
								variant="ghost"
								onClick={() => onChange(ct.name)}
								aria-pressed={active}
								aria-label={
									display.needsDisambiguation
										? `${display.label}, saved as ${ct.name}`
										: display.label
								}
								className={`${ROW_BASE} ${
									active
										? "bg-nova-violet/10 text-nova-violet-bright not-disabled:hover:bg-nova-violet/15"
										: "text-nova-text not-disabled:hover:bg-white/[0.06]"
								}`}
							>
								<Icon
									icon={tablerDatabase}
									width="14"
									height="14"
									className={
										active ? "text-nova-violet-bright" : "text-nova-text-muted"
									}
								/>
								<span className="min-w-0 flex-1">
									<span className="block break-words">{display.label}</span>
									{display.needsDisambiguation && (
										<span className="mt-0.5 block break-words text-xs font-normal text-nova-text-muted">
											Saved as {ct.name}
										</span>
									)}
								</span>
								{active && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright shrink-0"
									/>
								)}
							</Button>
						);
					})}
				</div>
			)}

			<div className="my-1.5 h-px shrink-0 bg-white/[0.06]" />

			{/* Create new */}
			<div className="shrink-0 px-1.5 pb-0.5">
				<label
					htmlFor={inputId}
					className="mb-2 block text-xs font-medium text-nova-text-muted"
				>
					Create case type
				</label>
				<div className="space-y-2">
					<Input
						id={inputId}
						type="text"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitNew();
							}
						}}
						placeholder="For example, Follow-up visit"
						autoComplete="off"
						data-1p-ignore
						aria-invalid={showError}
						aria-describedby={showError ? errorId : undefined}
						className={`min-h-11 bg-nova-deep/50 px-2.5 text-sm text-nova-text placeholder:text-nova-text-muted ${
							showError
								? "border-nova-rose/50 focus-visible:border-nova-rose focus-visible:ring-nova-rose/20"
								: "border-white/[0.06] focus-visible:border-nova-violet"
						}`}
					/>
					<Button
						type="button"
						variant="ghost"
						onClick={commitNew}
						disabled={!verdict.ok}
						className="min-h-11 w-full gap-1 bg-nova-violet/15 px-3 text-sm text-nova-violet-bright not-disabled:hover:bg-nova-violet/25"
					>
						<Icon icon={tablerPlus} width="15" height="15" />
						Create
					</Button>
				</div>
				{showError && !verdict.ok && (
					<p
						id={errorId}
						role="alert"
						className="mt-1 px-0.5 text-xs text-nova-rose"
					>
						{creationErrorMessage(verdict, candidate)}
					</p>
				)}
			</div>

			{onClear && value && (
				<>
					<div className="my-1.5 h-px shrink-0 bg-white/[0.06]" />
					<Button
						type="button"
						variant="ghost"
						onClick={onClear}
						className={`${ROW_BASE} text-nova-text-muted not-disabled:hover:bg-white/[0.06] not-disabled:hover:text-nova-text`}
					>
						<Icon icon={tablerX} width="14" height="14" />
						<span className="flex-1">Stop managing cases</span>
					</Button>
				</>
			)}
		</div>
	);
}

interface CaseTypePickerProps extends CaseTypePickerContentProps {
	/** Placeholder shown on the trigger when no value is set. */
	readonly placeholder?: string;
	/** Accessible label for the trigger. */
	readonly ariaLabel?: string;
	/** Lets a parent confirmation return focus after the popover choice unmounts. */
	readonly triggerRef?: Ref<HTMLButtonElement>;
}

/**
 * Standalone trigger + popover wrapping `CaseTypePickerContent`. The trigger
 * shows the bound case type (or a placeholder); choosing or clearing closes
 * the popover. Used by the module-settings Case Type section.
 */
export function CaseTypePicker({
	value,
	onChange,
	onClear,
	placeholder = "Pick a case type",
	ariaLabel = "Case type",
	triggerRef,
}: CaseTypePickerProps) {
	const caseTypes = useCaseTypes();
	const [open, setOpen] = useState(false);
	const displays = useMemo(
		() => caseTypeDisplays(caseTypes.map((caseType) => caseType.name)),
		[caseTypes],
	);
	const selectedDisplay = value
		? (displays.get(value) ?? {
				label: humanizeId(value),
				needsDisambiguation: false,
			})
		: null;
	const triggerLabel = selectedDisplay?.label ?? placeholder;
	const storedValueHint =
		value && selectedDisplay?.needsDisambiguation ? value : null;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				ref={triggerRef}
				render={<Button type="button" variant="outline" />}
				aria-label={`${ariaLabel}: ${triggerLabel}${storedValueHint ? `, saved as ${storedValueHint}` : ""}`}
				className="group h-auto min-h-11 w-full justify-between gap-2 whitespace-normal border-white/[0.06] bg-nova-deep/50 px-3 py-2 text-sm text-nova-text not-disabled:hover:border-nova-violet/30"
			>
				<span className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
					<Icon
						icon={tablerDatabase}
						width="14"
						height="14"
						className={`mt-0.5 shrink-0 ${
							value ? "text-nova-violet-bright" : "text-nova-text-muted"
						}`}
					/>
					<span className="min-w-0 flex-1">
						<span
							className={`block break-words ${value ? "text-nova-text" : "text-nova-text-muted"}`}
						>
							{triggerLabel}
						</span>
						{storedValueHint && (
							<span
								aria-hidden="true"
								className="mt-0.5 block break-words text-xs font-normal text-nova-text-muted"
							>
								Saved as {storedValueHint}
							</span>
						)}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</PopoverTrigger>
			<PopoverContent
				side="bottom"
				align="start"
				sideOffset={6}
				collisionPadding={8}
				className="max-h-[min(24rem,var(--available-height,24rem))] w-72 max-w-[calc(var(--available-width)-0.5rem)] gap-0 overflow-hidden p-0"
			>
				<CaseTypePickerContent
					value={value}
					onChange={(name) => {
						onChange(name);
						setOpen(false);
					}}
					{...(onClear && {
						onClear: () => {
							onClear();
							setOpen(false);
						},
					})}
				/>
			</PopoverContent>
		</Popover>
	);
}
