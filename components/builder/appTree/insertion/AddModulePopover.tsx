// components/builder/appTree/insertion/AddModulePopover.tsx
//
// The "+ add module" popover opened from a tree insertion point. Two steps:
//   1. Pick an archetype — Case List (case-managing) or Survey (menu, no case).
//   2. (Case List only) pick or create the case type, embedding
//      `CaseTypePickerContent` inline.
// On commit it dispatches the atomic, born-valid scaffold through the gated
// hook (`createCaseListModule` / `createSurveyModule`) and navigates to the new
// module. A gate rejection (rare — the scaffolds are valid by construction) is
// surfaced inline rather than only as a toast.

"use client";
import { Popover } from "@base-ui/react/popover";
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerClipboardText from "@iconify-icons/tabler/clipboard-text";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTable from "@iconify-icons/tabler/table";
import { useState } from "react";
import { CaseTypePickerContent } from "@/components/builder/shared/CaseTypePicker";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useNavigate } from "@/lib/routing/hooks";
import {
	POPOVER_POPUP_CLS,
	POPOVER_POSITIONER_ELEVATED_CLS,
} from "@/lib/styles";
import { INSERTION_TRIGGER_CLS } from "./TreeInsertionAffordance";

interface AddModulePopoverProps {
	/** Insertion index in `moduleOrder`. */
	readonly atIndex: number;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}

export function AddModulePopover({
	atIndex,
	open,
	onOpenChange,
}: AddModulePopoverProps) {
	const [step, setStep] = useState<"choose" | "caselist">("choose");
	const [error, setError] = useState<string | null>(null);
	const { createCaseListModule, createSurveyModule } = useBlueprintMutations();
	const { openModule } = useNavigate();

	const close = () => onOpenChange(false);

	const handleOpenChange = (next: boolean) => {
		onOpenChange(next);
		if (!next) {
			// Reset for the next open.
			setStep("choose");
			setError(null);
		}
	};

	const handleSurvey = () => {
		const outcome = createSurveyModule({ index: atIndex });
		if (outcome.ok) {
			openModule(outcome.uuid);
			close();
		} else {
			setError(outcome.messages.join(" "));
		}
	};

	const handleCaseList = (caseType: string) => {
		const outcome = createCaseListModule({ caseType, index: atIndex });
		if (outcome.ok) {
			openModule(outcome.uuid);
			close();
		} else {
			setError(outcome.messages.join(" "));
		}
	};

	return (
		<Popover.Root open={open} onOpenChange={handleOpenChange}>
			<Tooltip content="Add module">
				<Popover.Trigger
					className={INSERTION_TRIGGER_CLS}
					aria-label="Add module"
				>
					<Icon icon={tablerPlus} width="12" height="12" />
				</Popover.Trigger>
			</Tooltip>
			<Popover.Portal>
				<Popover.Positioner
					side="bottom"
					align="center"
					sideOffset={6}
					className={POPOVER_POSITIONER_ELEVATED_CLS}
				>
					<Popover.Popup className={POPOVER_POPUP_CLS}>
						<div className="w-64 p-1.5">
							{step === "choose" ? (
								<>
									<div className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-nova-text-muted">
										Add module
									</div>
									<ArchetypeRow
										icon={tablerTable}
										title="Case List"
										subtitle="Manages a case type"
										onClick={() => {
											setError(null);
											setStep("caselist");
										}}
									/>
									<ArchetypeRow
										icon={tablerClipboardText}
										title="Survey"
										subtitle="Forms only — no cases"
										onClick={handleSurvey}
									/>
								</>
							) : (
								<>
									<button
										type="button"
										onClick={() => {
											setStep("choose");
											setError(null);
										}}
										className="w-full flex items-center gap-1 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
									>
										<Icon icon={tablerChevronLeft} width="12" height="12" />
										Case list
									</button>
									<CaseTypePickerContent onChange={handleCaseList} />
								</>
							)}
							{error && (
								<p className="mt-1 px-2.5 pb-1 text-[11px] text-nova-rose/90">
									{error}
								</p>
							)}
						</div>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

function ArchetypeRow({
	icon,
	title,
	subtitle,
	onClick,
}: {
	icon: Parameters<typeof Icon>[0]["icon"];
	title: string;
	subtitle: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-white/[0.06] transition-colors cursor-pointer"
		>
			<div className="w-7 h-7 shrink-0 rounded-lg bg-nova-violet/10 flex items-center justify-center">
				<Icon
					icon={icon}
					width="15"
					height="15"
					className="text-nova-violet-bright"
				/>
			</div>
			<div className="min-w-0">
				<div className="text-[13px] font-medium text-nova-text">{title}</div>
				<div className="text-[11px] text-nova-text-muted truncate">
					{subtitle}
				</div>
			</div>
		</button>
	);
}
