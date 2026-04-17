"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { useCallback, useContext } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { Field, FieldKind } from "@/lib/domain";
import {
	fieldKindIcons,
	fieldKindLabels,
	INSERTION_CATEGORIES,
	INSERTION_TOP_LEVEL,
} from "@/lib/fieldTypeIcons";
import { useSelect } from "@/lib/routing/hooks";
import { useMarkNewField } from "@/lib/session/hooks";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";

interface FieldTypePickerPopupProps {
	/** Insertion index within the parent's children array. */
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
}

/**
 * Popup content for the question insertion menu.
 *
 * Renders the portal, positioner, popup shell, and categorised menu items.
 * Rendered as a child of the shared `Menu.Root` in `FormRenderer` — each
 * `InsertionPoint` sends its context (`atIndex`, `parentUuid`) as payload
 * via detached `Menu.Trigger`s connected through `Menu.createHandle()`.
 * Base UI's `FloatingTreeStore` is initialised by the root `Menu.Root`,
 * allowing submenus to register as tree children and preventing spurious
 * dismiss events during submenu hover transitions.
 *
 * Menu close is handled automatically by `Menu.Item`'s `closeOnClick` default —
 * no explicit close callback is needed.
 */
export function FieldTypePickerPopup({
	atIndex,
	parentUuid,
}: FieldTypePickerPopupProps) {
	const { setPending } = useScrollIntoView();
	const select = useSelect();
	const { addField } = useBlueprintMutations();
	const markNewField = useMarkNewField();
	const docStore = useContext(BlueprintDocContext);

	/** Generate a unique ID, create the field, and select it.
	 *  Reads the doc store imperatively at insert time — avoids N
	 *  reactive subscriptions to entity maps that would fire on every
	 *  unrelated field edit. */
	const handleSelect = useCallback(
		(kind: FieldKind) => {
			if (!docStore) return;

			/* Collect all existing field IDs to generate a unique name.
			 * CommCare requires unique IDs across the entire form, not just
			 * siblings, so we scan the full field entity map. */
			const doc = docStore.getState();
			const existingIds = new Set<string>();
			for (const f of Object.values(doc.fields)) {
				if (f) existingIds.add(f.id);
			}

			let newId = `new_${kind}`;
			if (existingIds.has(newId)) {
				let counter = 2;
				while (existingIds.has(`new_${kind}_${counter}`)) counter++;
				newId = `new_${kind}_${counter}`;
			}

			const isSelect = kind === "single_select" || kind === "multi_select";
			const defaultOptions = isSelect
				? [
						{ value: "option_1", label: "Option 1" },
						{ value: "option_2", label: "Option 2" },
					]
				: undefined;

			// Build a partial Field in the domain shape. We cast through the
			// no-uuid partial the hook accepts — the union narrows on `kind`,
			// so each variant's allowed properties are enforced at dispatch.
			const newField = {
				id: newId,
				kind,
				label: "New Question",
				...(defaultOptions ? { options: defaultOptions } : {}),
			} as unknown as Omit<Field, "uuid">;

			const newUuid = addField(parentUuid, newField, { atIndex });

			/* Mark as new question so the UI can apply entry animations, then
			 * select and scroll to the newly-inserted question. */
			markNewField(newUuid);
			setPending(newUuid, "smooth", false);
			select(newUuid);
		},
		[parentUuid, atIndex, addField, markNewField, setPending, select, docStore],
	);

	return (
		<Menu.Portal>
			<Menu.Positioner
				className={MENU_POSITIONER_CLS}
				sideOffset={8}
				collisionPadding={8}
			>
				<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 192 }}>
					{/* ── Category submenus ── */}
					{INSERTION_CATEGORIES.map((cat) => (
						<Menu.SubmenuRoot key={cat.label}>
							<Menu.SubmenuTrigger className={MENU_ITEM_CLS}>
								<Icon
									icon={cat.icon}
									width="16"
									height="16"
									className="text-nova-text-muted shrink-0"
								/>
								<span className="flex-1 text-left">{cat.label}</span>
								<Icon
									icon={tablerChevronRight}
									width="14"
									height="14"
									className="text-nova-text-muted/50 shrink-0 -mr-0.5"
								/>
							</Menu.SubmenuTrigger>
							<Menu.Portal>
								<Menu.Positioner
									className={MENU_SUBMENU_POSITIONER_CLS}
									sideOffset={4}
								>
									<Menu.Popup className={MENU_POPUP_CLS}>
										{cat.types.map((type) => (
											<TypeMenuItem
												key={type}
												type={type}
												onSelect={handleSelect}
											/>
										))}
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.SubmenuRoot>
					))}

					<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />

					{/* ── Top-level items (no submenu) ── */}
					{INSERTION_TOP_LEVEL.map((type) => (
						<TypeMenuItem key={type} type={type} onSelect={handleSelect} />
					))}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

/* ── Reusable menu item for a single question type ─────────────────────── */

function TypeMenuItem({
	type,
	onSelect,
}: {
	type: FieldKind;
	onSelect: (type: FieldKind) => void;
}) {
	const icon = fieldKindIcons[type];
	const label = fieldKindLabels[type] ?? type;
	return (
		<Menu.Item className={MENU_ITEM_CLS} onClick={() => onSelect(type)}>
			{icon && (
				<Icon
					icon={icon}
					width="16"
					height="16"
					className="text-nova-text-muted shrink-0"
				/>
			)}
			<span>{label}</span>
		</Menu.Item>
	);
}
