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
import { formSectionsOf } from "@/lib/doc/formSectionVerdicts";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { type FieldKind, fieldKinds, fieldRegistry } from "@/lib/domain";
import { useSelect } from "@/lib/routing/hooks";
import { useMarkNewField } from "@/lib/session/hooks";
import {
	FLOATING_LAYER_CLS,
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";
import { NEW_FIELD_BUILDERS } from "./newFieldDefaults";
import {
	type SectionGestureItem,
	sectionGestureItems,
} from "./sectionGestureItems";

/* ── Insertion menu organization ────────────────────────────────────────
 * Menu-layout-only concern: which kinds group into submenus, which kinds
 * render as direct level-1 items. The picker is the single consumer:
 * co-located rather than pulled into the domain layer because field
 * grouping is a UI decision, not a data-model invariant.
 *
 * Categories with 2+ types render as submenus; top-level items render as
 * direct `Menu.Item`s (e.g. Hidden: single-purpose types that don't
 * belong in a family).
 *
 * `section` is never a flat kind here: a page's place is PLANNED (it
 * lives only at the root, and once a form has one the whole root is
 * pages), so the Structure submenu offers the page gestures
 * `sectionGestureItems` computes for the gap instead, and the gap at the
 * root of a sectioned form offers nothing but a new page. */

interface InsertionCategory {
	/** Human label shown on the submenu trigger. */
	label: string;
	/** Representative icon for the category trigger row. */
	icon: IconifyIcon;
	/** Field kinds surfaced inside the submenu. */
	types: readonly FieldKind[];
}

/** The container kinds offered as plain kinds: the boxed ones. A page is
 *  a gesture (`sectionGestureItems`), never a flat kind, so it is the one
 *  container left out. */
const BOXED_CONTAINER_KINDS: readonly FieldKind[] = fieldKinds.filter(
	(kind) => fieldRegistry[kind].isContainer && kind !== "section",
);

/** Grouped families: each becomes a submenu in the insertion menu. */
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
		// Barcode rides here rather than under Input: it is a scan, not
		// something the worker types. It is not a capture kind, its answer
		// is the scanned text, not an attachment.
		label: "Attachments and scanning",
		icon: tablerPhoto,
		types: ["image", "audio", "video", "file", "signature", "barcode"],
	},
	{ label: "Structure", icon: tablerFolder, types: BOXED_CONTAINER_KINDS },
];

/** The Structure submenu's label: the page gestures ride in it. */
const STRUCTURE_LABEL = "Structure";

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
	 *  lifetime: the anchor InsertionPoint pins its line while this matches. */
	onActiveTargetChange: (
		target: { atIndex: number; parentUuid: Uuid } | null,
	) => void;
}

/**
 * Popup content for the field insertion menu.
 *
 * Renders the portal, positioner, popup shell, and categorised menu items.
 * Rendered as a child of the shared `Menu.Root` in `FormRenderer`, each
 * `InsertionPoint` sends its context (`atIndex`, `parentUuid`) as payload
 * via detached `Menu.Trigger`s connected through `Menu.createHandle()`.
 * Base UI's `FloatingTreeStore` is initialised by the root `Menu.Root`,
 * allowing submenus to register as tree children and preventing spurious
 * dismiss events during submenu hover transitions.
 *
 * Menu close is handled automatically by `Menu.Item`'s `closeOnClick` default:
 * no explicit close callback is needed.
 */
export function FieldTypePickerPopup({
	atIndex,
	parentUuid,
	onActiveTargetChange,
}: FieldTypePickerPopupProps) {
	const { setPending } = useScrollIntoView();
	const select = useSelect();
	const { addField, applyFormSectionPlan } = useBlueprintMutations();
	const markNewField = useMarkNewField();
	const docStore = useContext(BlueprintDocContext);

	/* What THIS gap can do, read once per open (the popup mounts per open).
	 * A sectioned root offers only a new page; a page offers the kinds plus
	 * a split; a sectionless root offers the kinds plus "Split into
	 * sections". Reading the doc imperatively here matches `handleSelect`. */
	const gestures = docStore
		? sectionGestureItems(docStore.getState(), parentUuid, atIndex)
		: undefined;

	/** Apply a page gesture and land on the page it produced: the one
	 *  section uuid that did not exist before the plan, else the first. */
	const handleGesture = useCallback(
		(item: SectionGestureItem) => {
			if (!docStore) return;
			const doc = docStore.getState();
			const formUuid =
				doc.forms[parentUuid] !== undefined
					? parentUuid
					: doc.fieldParent[parentUuid];
			const before = new Set(
				formUuid === undefined ? [] : formSectionsOf(doc, formUuid),
			);
			const outcome = applyFormSectionPlan(item.plan(doc));
			if (!outcome.ok) return;
			const landed =
				outcome.sectionUuids?.find((uuid) => !before.has(uuid)) ??
				outcome.sectionUuids?.[0];
			if (landed === undefined) return;
			markNewField(landed);
			setPending(landed, "smooth", false);
			select(landed);
		},
		[
			docStore,
			parentUuid,
			applyFormSectionPlan,
			markNewField,
			setPending,
			select,
		],
	);

	/** Generate a unique ID, create the field, and select it.
	 *  Reads the doc store imperatively at insert time: avoids N
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
			// map: each kind's shape is checked against its own schema, so an
			// invalid default (e.g. a `label` on `hidden`) can't be minted. The
			// label mirrors the kind's human-readable name (e.g. "New Text",
			// "New Single Select") so a freshly-added field is self-describing;
			// kinds with no label slot ignore it.
			const newField = NEW_FIELD_BUILDERS[kind](
				newId,
				`New ${fieldRegistry[kind].label}`,
			);

			const outcome = addField(parentUuid, newField, { atIndex });
			/* A rejected insert (the commit gate refused the batch: the
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
				className={`${FLOATING_LAYER_CLS} ${MENU_POSITIONER_CLS}`}
				sideOffset={8}
				collisionPadding={8}
			>
				<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 192 }}>
					<ActiveTargetReporter
						atIndex={atIndex}
						parentUuid={parentUuid}
						onChange={onActiveTargetChange}
					/>
					{gestures !== undefined && !gestures.offersKinds ? (
						/* ── Root of a sectioned form: a page break offers a page. ── */
						gestures.items.map((item) => (
							<GestureMenuItem
								key={item.key}
								item={item}
								onSelect={handleGesture}
							/>
						))
					) : (
						<>
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
											className={`${FLOATING_LAYER_CLS} ${MENU_SUBMENU_POSITIONER_CLS}`}
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
												{/* The page gestures ride in Structure: a split
												 *  or a new page is structure, not a question. */}
												{cat.label === STRUCTURE_LABEL &&
													gestures !== undefined &&
													gestures.items.length > 0 && (
														<>
															<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />
															{gestures.items.map((item) => (
																<GestureMenuItem
																	key={item.key}
																	item={item}
																	onSelect={handleGesture}
																/>
															))}
														</>
													)}
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
						</>
					)}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

/** Reports the menu's open target for the lifetime of `Menu.Popup`'s mount:
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

/* ── A page gesture: split here, or a new page ─────────────────────── */

function GestureMenuItem({
	item,
	onSelect,
}: {
	item: SectionGestureItem;
	onSelect: (item: SectionGestureItem) => void;
}) {
	const disabled = item.disabledReason !== undefined;
	return (
		<Menu.Item
			disabled={disabled}
			onClick={disabled ? undefined : () => onSelect(item)}
			className={disabled ? MENU_ITEM_DISABLED_CLS : MENU_ITEM_CLS}
		>
			<Icon
				icon={fieldRegistry.section.icon}
				width="16"
				height="16"
				className="text-nova-text-muted shrink-0"
			/>
			<span className="flex min-w-0 flex-1 flex-col text-left">
				<span>{item.label}</span>
				{item.disabledReason !== undefined && (
					<span className="text-xs text-nova-text-muted">
						{item.disabledReason}
					</span>
				)}
			</span>
		</Menu.Item>
	);
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
