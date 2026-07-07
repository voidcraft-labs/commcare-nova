"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerCircleDot from "@iconify-icons/tabler/circle-dot";
import tablerFolder from "@iconify-icons/tabler/folder";
import tablerForms from "@iconify-icons/tabler/forms";
import tablerPhoto from "@iconify-icons/tabler/photo";
import { useCallback, useContext, useEffect } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { type FieldKind, fieldRegistry } from "@/lib/domain";
import { useSelect } from "@/lib/routing/hooks";
import { useMarkNewField } from "@/lib/session/hooks";
import {
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { NEW_FIELD_BUILDERS } from "./newFieldDefaults";

/* ── Insertion menu organization ────────────────────────────────────────
 * Menu-layout-only concern: which kinds group into submenus, which kinds
 * render as direct level-1 items. The picker is the single consumer —
 * co-located rather than pulled into the domain layer because field
 * grouping is a UI decision, not a data-model invariant.
 *
 * Categories with 2+ types render as submenus; top-level items render as
 * direct `Menu.Item`s (e.g. Hidden — single-purpose types that don't
 * belong in a family). */

interface InsertionCategory {
	/** Human label shown on the submenu trigger. */
	label: string;
	/** Representative icon for the category trigger row. */
	icon: IconifyIcon;
	/** Field kinds surfaced inside the submenu. */
	types: readonly FieldKind[];
}

/** Grouped families — each becomes a submenu in the insertion menu. */
const INSERTION_CATEGORIES: readonly InsertionCategory[] = [
	{
		label: "Input",
		icon: tablerForms,
		types: ["text", "int", "decimal", "secret"],
	},
	{
		label: "Date & Time",
		icon: tablerCalendar,
		types: ["date", "time", "datetime"],
	},
	{
		label: "Choice",
		icon: tablerCircleDot,
		types: ["single_select", "multi_select"],
	},
	{
		label: "Media",
		icon: tablerPhoto,
		types: ["image", "audio", "video", "barcode", "signature"],
	},
	{ label: "Structure", icon: tablerFolder, types: ["group", "repeat"] },
];

/** Standalone kinds rendered as level-1 items (no submenu needed). */
const INSERTION_TOP_LEVEL: readonly FieldKind[] = [
	"geopoint",
	"label",
	"hidden",
];

interface FieldTypePickerPopupProps {
	/** Insertion index within the parent's children array. */
	atIndex: number;
	/** UUID of the parent container (form for root-level, group/repeat uuid for nested). */
	parentUuid: Uuid;
	/** Reports which insertion location the menu is open for (null on close).
	 *  Fired from inside `Menu.Popup`, whose mount is exactly the menu's open
	 *  lifetime — the anchor InsertionPoint pins its line while this matches. */
	onActiveTargetChange: (
		target: { atIndex: number; parentUuid: Uuid } | null,
	) => void;
}

/**
 * Popup content for the field insertion menu.
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
	onActiveTargetChange,
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

			// Build the kind's starter field through the typed per-kind builder
			// map — each kind's shape is checked against its own schema, so an
			// invalid default (e.g. a `label` on `hidden`) can't be minted. The
			// label mirrors the kind's human-readable name (e.g. "New Text",
			// "New Single Select") so a freshly-added field is self-describing;
			// kinds with no label slot ignore it.
			const newField = NEW_FIELD_BUILDERS[kind](
				newId,
				`New ${fieldRegistry[kind].label}`,
			);

			const outcome = addField(parentUuid, newField, { atIndex });
			/* A rejected insert (the commit gate refused the batch — the
			 * rejection toast already names the findings) must not navigate:
			 * there is no new field to mark, scroll to, or select, and
			 * re-selecting a phantom would kick the user off the field they
			 * had open. */
			if (!outcome.ok) return;

			/* Mark as new field so the UI can apply entry animations, then
			 * select and scroll to the newly-inserted field. */
			markNewField(outcome.uuid);
			setPending(outcome.uuid, "smooth", false);
			select(outcome.uuid);
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
					<ActiveTargetReporter
						atIndex={atIndex}
						parentUuid={parentUuid}
						onChange={onActiveTargetChange}
					/>
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
									className="text-nova-text-muted shrink-0 -mr-0.5"
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

/** Reports the menu's open target for the lifetime of `Menu.Popup`'s mount —
 *  Base UI unmounts the popup on close (default `keepMounted: false`), so the
 *  effect's setup/cleanup brackets exactly the open window, independent of
 *  HOW the menu was opened or closed. Renders nothing. */
function ActiveTargetReporter({
	atIndex,
	parentUuid,
	onChange,
}: {
	atIndex: number;
	parentUuid: Uuid;
	onChange: FieldTypePickerPopupProps["onActiveTargetChange"];
}) {
	useEffect(() => {
		onChange({ atIndex, parentUuid });
		return () => onChange(null);
	}, [atIndex, parentUuid, onChange]);
	return null;
}

/* ── Reusable menu item for a single field kind ─────────────────────── */

function TypeMenuItem({
	type,
	onSelect,
}: {
	type: FieldKind;
	onSelect: (type: FieldKind) => void;
}) {
	const { icon, label } = fieldRegistry[type];
	return (
		<Menu.Item className={MENU_ITEM_CLS} onClick={() => onSelect(type)}>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="text-nova-text-muted shrink-0"
			/>
			<span>{label}</span>
		</Menu.Item>
	);
}
