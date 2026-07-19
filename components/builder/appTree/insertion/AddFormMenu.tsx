// components/builder/appTree/insertion/AddFormMenu.tsx
//
// The "+ add form" menu opened from a form insertion point inside a module.
// Lists the four form types; case-managing types (registration / follow-up /
// close) require the module to have a case type, so on a typeless (survey)
// module they render disabled with the reason — "disabled, never hidden", the
// builder's valid-by-construction rule. Selecting a type dispatches the atomic
// `createForm` scaffold (form + a default first field) and navigates to it.

"use client";
import { Icon } from "@iconify/react/offline";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	CASE_FORM_TYPES,
	FORM_TYPES,
	type FormType,
	formTypeLabels,
	type Uuid,
} from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import {
	INSERTION_TRIGGER_CLS,
	insertionTriggerStyle,
	TreeInsertionLine,
	useTreeInsertionZone,
} from "./TreeInsertionAffordance";

/** Menu-only one-line description per form type (label + icon + the
 *  needs-a-case-type gate all come from the domain — `formTypeLabels`,
 *  `formTypeIcons`, `CASE_FORM_TYPES` — so this surface can't drift from them). */
const FORM_TYPE_DESC: Record<FormType, string> = {
	registration: "Creates a new case",
	followup: "Updates a case",
	close: "Closes a case",
	survey: "Collects data without a case",
};

interface AddFormMenuProps {
	readonly moduleUuid: Uuid;
	/** Whether the module has a case type (gates the case-managing types). */
	readonly hasCaseType: boolean;
	/** Insertion index in the module's `formOrder`. */
	readonly atIndex: number;
	/** The final insertion point is the one persistent keyboard/AT action. */
	readonly prominent?: boolean;
}

export function AddFormMenu({
	moduleUuid,
	hasCaseType,
	atIndex,
	prominent = false,
}: AddFormMenuProps) {
	const [open, setOpen] = useState(false);
	const { createForm } = useBlueprintMutations();
	const { openForm } = useNavigate();
	const { revealed, progress, ref } = useTreeInsertionZone(open);
	const canEdit = useCanEdit();

	const handleSelect = (type: FormType) => {
		const outcome = createForm(moduleUuid, type, atIndex);
		// A rejection already announces via the hook's toast; only navigate on
		// success (there's no form to open otherwise).
		if (outcome.ok) openForm(moduleUuid, outcome.uuid);
	};

	// A view-only Project member can't add forms — drop the "+" strip.
	if (!canEdit) return null;

	return (
		<li>
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger
					ref={ref}
					className={`${INSERTION_TRIGGER_CLS} ${prominent ? "h-11" : "h-2"}`}
					style={insertionTriggerStyle(revealed, prominent)}
					tabIndex={prominent ? 0 : -1}
					aria-hidden={prominent ? undefined : true}
					aria-label="Add form"
				>
					{/* Indented to the form rows' depth (FormCard is pl-5) so the
					 *  affordance reads as INSIDE the module — the strip directly
					 *  below it is the full-width "+ Module" one. */}
					<TreeInsertionLine
						revealed={prominent || revealed}
						progress={progress}
						label={prominent ? "Add form" : "Form"}
						insetCls="left-5 right-3"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side="bottom"
					align="center"
					sideOffset={6}
					preferredMinWidth={220}
				>
					{FORM_TYPES.map((type) => {
						// Case-managing types need a case type; survey never does —
						// the domain's CASE_FORM_TYPES is the single source of that gate.
						const disabled = CASE_FORM_TYPES.has(type) && !hasCaseType;
						return (
							<DropdownMenuItem
								key={type}
								disabled={disabled}
								onClick={() => handleSelect(type)}
								className="min-h-14"
							>
								<Icon
									icon={formTypeIcons[type]}
									width="16"
									height="16"
									className="text-nova-text-muted shrink-0"
								/>
								<span className="flex-1 min-w-0">
									<span className="block">{formTypeLabels[type]}</span>
									<span className="block text-xs text-nova-text-muted">
										{disabled ? "Needs a case type" : FORM_TYPE_DESC[type]}
									</span>
								</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}
