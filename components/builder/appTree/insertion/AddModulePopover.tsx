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
import { Icon } from "@iconify/react/offline";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerClipboardText from "@iconify-icons/tabler/clipboard-text";
import tablerTable from "@iconify-icons/tabler/table";
import { useState } from "react";
import { CaseTypePickerContent } from "@/components/builder/shared/CaseTypePicker";
import { Button } from "@/components/shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/shadcn/popover";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import {
	INSERTION_TRIGGER_CLS,
	insertionTriggerStyle,
	TreeInsertionLine,
	useTreeInsertionZone,
} from "./TreeInsertionAffordance";

interface AddModulePopoverProps {
	/** Insertion index in `moduleOrder`. */
	readonly atIndex: number;
	/** The final insertion point is the one persistent keyboard/AT action. */
	readonly prominent?: boolean;
}

export function AddModulePopover({
	atIndex,
	prominent = false,
}: AddModulePopoverProps) {
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<"choose" | "caselist">("choose");
	const [error, setError] = useState<string | null>(null);
	// Inline flavor: a (rare) gate rejection surfaces in this popover's own
	// error line, not as a toast — the popover owns the feedback.
	const { inline } = useBlueprintMutations();
	const { openModule, openCaseList } = useNavigate();
	const { revealed, progress, ref } = useTreeInsertionZone(open);
	const canEdit = useCanEdit();

	// Reset transient state whenever the popover closes — by dismiss
	// (Base UI calls `onOpenChange`) OR by a programmatic close after a
	// successful create (`close()`, which sets `open` directly). Both routes
	// go through here so the next open always starts at "choose".
	const reset = () => {
		setStep("choose");
		setError(null);
	};

	const close = () => {
		reset();
		setOpen(false);
	};

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) reset();
	};

	const handleSurvey = () => {
		const outcome = inline.createSurveyModule({ index: atIndex });
		if (outcome.ok) {
			openModule(outcome.uuid);
			close();
		} else {
			setError(outcome.messages.join(" "));
		}
	};

	const handleCaseList = (caseType: string) => {
		const outcome = inline.createCaseListModule({ caseType, index: atIndex });
		if (outcome.ok) {
			// Born a `caseListOnly` viewer (no forms), so its home is the case
			// list, not an empty form menu — land on the config directly.
			openCaseList(outcome.uuid);
			close();
		} else {
			setError(outcome.messages.join(" "));
		}
	};

	// A view-only Project member can't add modules — drop the "+" strip.
	if (!canEdit) return null;

	return (
		<li>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger
					ref={ref}
					className={`${INSERTION_TRIGGER_CLS} ${prominent ? "h-11" : "h-2"}`}
					style={insertionTriggerStyle(revealed, prominent)}
					tabIndex={prominent ? 0 : -1}
					aria-hidden={prominent ? undefined : true}
					aria-label="Add module"
				>
					<TreeInsertionLine
						revealed={prominent || revealed}
						progress={progress}
						label={prominent ? "Add module" : "Module"}
					/>
				</PopoverTrigger>
				<PopoverContent
					side="bottom"
					align="center"
					sideOffset={6}
					className="w-64 gap-0 p-1.5"
				>
					<PopoverTitle className="sr-only">Add module</PopoverTitle>
					<PopoverDescription className="sr-only">
						Choose the kind of module to add
					</PopoverDescription>
					<div>
						{step === "choose" ? (
							<>
								<ArchetypeRow
									icon={tablerTable}
									title="Case list"
									subtitle="Manages a case type"
									onClick={() => {
										setError(null);
										setStep("caselist");
									}}
								/>
								<ArchetypeRow
									icon={tablerClipboardText}
									title="Survey"
									subtitle="Forms without cases"
									onClick={handleSurvey}
								/>
							</>
						) : (
							<>
								<Button
									type="button"
									variant="ghost"
									size="xl"
									onClick={() => {
										setStep("choose");
										setError(null);
									}}
									className="h-11 w-full justify-start gap-1 px-2 text-sm text-nova-text-muted hover:text-nova-text"
								>
									<Icon icon={tablerChevronLeft} width="12" height="12" />
									Back to module choices
								</Button>
								<CaseTypePickerContent onChange={handleCaseList} />
							</>
						)}
						{error && (
							<p className="mt-1 px-2.5 pb-1 text-xs text-nova-rose">{error}</p>
						)}
					</div>
				</PopoverContent>
			</Popover>
		</li>
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
		<Button
			type="button"
			variant="ghost"
			size="xl"
			onClick={onClick}
			className="h-auto min-h-14 w-full justify-start gap-2.5 whitespace-normal px-2.5 py-2 text-left hover:bg-white/[0.06]"
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
				<div className="text-sm font-medium text-nova-text">{title}</div>
				<div className="truncate text-xs font-normal text-nova-text-muted">
					{subtitle}
				</div>
			</div>
		</Button>
	);
}
