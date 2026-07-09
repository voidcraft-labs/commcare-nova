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
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useMemo, useRef, useState } from "react";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { caseTypeNameVerdict } from "@/lib/doc/identifierVerdicts";
import {
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
} from "@/lib/styles";

const ROW_BASE =
	"w-full flex items-center gap-2 px-3 min-h-11 text-[13px] rounded-lg cursor-pointer transition-colors text-left";

interface CaseTypePickerContentProps {
	/** The currently-bound case type, highlighted in the list. */
	readonly value?: string;
	/** Fired when a case type is chosen (existing) or created (new). */
	readonly onChange: (name: string) => void;
	/** When provided, a "Clear case type" row shows (settings only). */
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

	const existingNames = useMemo(
		() => new Set(caseTypes.map((c) => c.name)),
		[caseTypes],
	);
	const verdict = useMemo(
		() => caseTypeNameVerdict(draft, existingNames),
		[draft, existingNames],
	);
	// Only surface the reason once the user has typed something — an empty
	// field shouldn't read as an error before they start.
	const showError = draft.trim().length > 0 && !verdict.ok;

	const commitNew = () => {
		if (!verdict.ok) return;
		onChange(draft.trim());
	};

	return (
		<div className="w-64 p-1.5">
			<div className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-nova-text-muted">
				Case type
			</div>

			{caseTypes.length === 0 ? (
				<div className="px-3 py-2 text-xs text-nova-text-muted italic">
					No case types yet — create one below.
				</div>
			) : (
				<div className="max-h-56 overflow-y-auto">
					{caseTypes.map((ct) => {
						const active = ct.name === value;
						return (
							<button
								key={ct.name}
								type="button"
								onClick={() => onChange(ct.name)}
								className={`${ROW_BASE} ${
									active
										? "text-nova-violet-bright bg-nova-violet/10"
										: "text-nova-text hover:bg-white/[0.06]"
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
								<span className="flex-1 font-mono truncate">{ct.name}</span>
								{active && (
									<Icon
										icon={tablerCheck}
										width="14"
										height="14"
										className="text-nova-violet-bright shrink-0"
									/>
								)}
							</button>
						);
					})}
				</div>
			)}

			<div className="my-1.5 h-px bg-white/[0.06]" />

			{/* Create new */}
			<div className="px-1.5 pb-0.5">
				<div className="flex items-center gap-1.5">
					<input
						type="text"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitNew();
							}
						}}
						placeholder="New case type…"
						autoComplete="off"
						data-1p-ignore
						aria-label="New case type name"
						aria-invalid={showError}
						className={`flex-1 min-w-0 px-2.5 min-h-11 text-[13px] font-mono rounded-lg bg-nova-deep/50 border text-nova-text placeholder:text-nova-text-muted placeholder:font-sans focus:outline-none transition-colors ${
							showError
								? "border-nova-rose/50 focus:border-nova-rose"
								: "border-white/[0.06] focus:border-nova-violet"
						}`}
					/>
					<button
						type="button"
						onClick={commitNew}
						disabled={!verdict.ok}
						className="shrink-0 min-h-11 flex items-center gap-1 px-3 rounded-lg text-[13px] font-medium bg-nova-violet/15 text-nova-violet-bright not-disabled:hover:bg-nova-violet/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
					>
						<Icon icon={tablerPlus} width="15" height="15" />
						Create
					</button>
				</div>
				{showError && !verdict.ok && (
					<p className="mt-1 px-0.5 text-[11px] text-nova-rose">
						{verdict.userMessage}
					</p>
				)}
			</div>

			{onClear && value && (
				<>
					<div className="my-1.5 h-px bg-white/[0.06]" />
					<button
						type="button"
						onClick={onClear}
						className={`${ROW_BASE} text-nova-text-muted hover:bg-white/[0.06] hover:text-nova-text`}
					>
						<Icon icon={tablerX} width="14" height="14" />
						<span className="flex-1">Clear case type</span>
					</button>
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
}: CaseTypePickerProps) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				ref={triggerRef}
				aria-label={`${ariaLabel}: ${value ?? placeholder}`}
				className="group w-full flex items-center justify-between gap-2 px-3 min-h-11 text-[13px] rounded-lg border border-white/[0.06] hover:border-nova-violet/30 bg-nova-deep/50 text-nova-text transition-colors cursor-pointer"
			>
				<span className="flex items-center gap-1.5 min-w-0">
					<Icon
						icon={tablerDatabase}
						width="14"
						height="14"
						className={
							value ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					/>
					<span
						className={`truncate font-mono ${value ? "text-nova-text" : "text-nova-text-muted"}`}
					>
						{value ?? placeholder}
					</span>
				</span>
				<Icon
					icon={tablerChevronDown}
					width="14"
					height="14"
					className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
				/>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="start"
					sideOffset={6}
					anchor={triggerRef}
					className={POPOVER_POSITIONER_ELEVATED_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
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
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
