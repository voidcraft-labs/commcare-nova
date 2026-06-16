// components/builder/appTree/insertion/AddFormMenu.tsx
//
// The "+ add form" menu opened from a form insertion point inside a module.
// Lists the four form types; case-managing types (registration / follow-up /
// close) require the module to have a case type, so on a typeless (survey)
// module they render disabled with the reason — "disabled, never hidden", the
// builder's valid-by-construction rule. Selecting a type dispatches the atomic
// `createForm` scaffold (form + a default first field) and navigates to it.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerClipboardText from "@iconify-icons/tabler/clipboard-text";
import tablerFilePencil from "@iconify-icons/tabler/file-pencil";
import tablerFilePlus from "@iconify-icons/tabler/file-plus";
import tablerFileX from "@iconify-icons/tabler/file-x";
import tablerPlus from "@iconify-icons/tabler/plus";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { FormType, Uuid } from "@/lib/domain";
import { useNavigate } from "@/lib/routing/hooks";
import {
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { INSERTION_TRIGGER_CLS } from "./TreeInsertionAffordance";

interface FormTypeItem {
	type: FormType;
	label: string;
	icon: IconifyIcon;
	desc: string;
	/** When true, the type needs the module to have a case type. */
	needsCaseType: boolean;
}

const FORM_TYPE_ITEMS: readonly FormTypeItem[] = [
	{
		type: "registration",
		label: "Registration",
		icon: tablerFilePlus,
		desc: "Creates a new case",
		needsCaseType: true,
	},
	{
		type: "followup",
		label: "Follow-up",
		icon: tablerFilePencil,
		desc: "Updates a case",
		needsCaseType: true,
	},
	{
		type: "close",
		label: "Close",
		icon: tablerFileX,
		desc: "Closes a case",
		needsCaseType: true,
	},
	{
		type: "survey",
		label: "Survey",
		icon: tablerClipboardText,
		desc: "Collects data — no case",
		needsCaseType: false,
	},
];

interface AddFormMenuProps {
	readonly moduleUuid: Uuid;
	/** Whether the module has a case type (gates the case-managing types). */
	readonly hasCaseType: boolean;
	/** Insertion index in the module's `formOrder`. */
	readonly atIndex: number;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
}

export function AddFormMenu({
	moduleUuid,
	hasCaseType,
	atIndex,
	open,
	onOpenChange,
}: AddFormMenuProps) {
	const { createForm } = useBlueprintMutations();
	const { openForm } = useNavigate();

	const handleSelect = (type: FormType) => {
		const outcome = createForm(moduleUuid, type, atIndex);
		// A rejection already announces via the hook's toast; only navigate on
		// success (there's no form to open otherwise).
		if (outcome.ok) openForm(moduleUuid, outcome.uuid);
	};

	return (
		<Menu.Root open={open} onOpenChange={onOpenChange}>
			<Tooltip content="Add form">
				<Menu.Trigger className={INSERTION_TRIGGER_CLS} aria-label="Add form">
					<Icon icon={tablerPlus} width="12" height="12" />
				</Menu.Trigger>
			</Tooltip>
			<Menu.Portal>
				<Menu.Positioner
					className={MENU_POSITIONER_CLS}
					side="bottom"
					align="center"
					sideOffset={6}
				>
					<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 220 }}>
						{FORM_TYPE_ITEMS.map((item) => {
							const disabled = item.needsCaseType && !hasCaseType;
							return (
								<Menu.Item
									key={item.type}
									disabled={disabled}
									onClick={() => handleSelect(item.type)}
									className={disabled ? MENU_ITEM_DISABLED_CLS : MENU_ITEM_CLS}
								>
									<Icon
										icon={item.icon}
										width="16"
										height="16"
										className="text-nova-text-muted shrink-0"
									/>
									<span className="flex-1 min-w-0">
										<span className="block">{item.label}</span>
										<span className="block text-[10px] text-nova-text-muted">
											{disabled ? "Needs a case type" : item.desc}
										</span>
									</span>
								</Menu.Item>
							);
						})}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
