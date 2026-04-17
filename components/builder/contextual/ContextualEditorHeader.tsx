"use client";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tablerArrowDown from "@iconify-icons/tabler/arrow-down";
import tablerArrowUp from "@iconify-icons/tabler/arrow-up";
import tablerArrowsExchange from "@iconify-icons/tabler/arrows-exchange";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerDotsVertical from "@iconify-icons/tabler/dots-vertical";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { FieldTypeList } from "@/components/builder/FieldTypeList";
import { tablerCopyPlus } from "@/components/icons/tablerExtras";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCommitField } from "@/hooks/useCommitField";
import { useSaveField } from "@/hooks/useSaveField";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	type CrossLevelFieldMoveTarget,
	getCrossLevelFieldMoveTargets,
	getFieldMoveTargets,
} from "@/lib/doc/navigation";
import { asUuid } from "@/lib/doc/types";
import { getConvertibleTypes } from "@/lib/domain";
import { fieldKindIcons, fieldKindLabels } from "@/lib/fieldTypeIcons";
import { shortcutLabel } from "@/lib/platform";
import { useDeleteSelectedField } from "@/lib/routing/builderActions";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import { useClearNewField, useIsNewField } from "@/lib/session/hooks";
import {
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
	POPOVER_POPUP_CLS,
} from "@/lib/styles";
import type { FieldEditorProps, FocusableFieldKey } from "./shared";
import { useFocusHint } from "./shared";

/** Field keys owned by the Header — only "id" for undo/redo focus hints. */
const HEADER_FIELDS = new Set<FocusableFieldKey>(["id"]);

/** Track whether the Shift key is currently held. Resets on window blur
 *  so a tab-switch doesn't leave a phantom pressed state. */
function useShiftKey(): boolean {
	const [shift, setShift] = useState(false);
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(true);
		};
		const up = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(false);
		};
		const blur = () => setShift(false);
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", blur);
		};
	}, []);
	return shift;
}

export function ContextualEditorHeader({ field }: FieldEditorProps) {
	const { setPending } = useScrollIntoView();
	const loc = useLocation();
	const select = useSelect();

	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;

	const isNewField = useIsNewField(selectedUuid ?? "");
	const clearNewField = useClearNewField();

	const {
		moveField,
		duplicateField,
		renameField: renameFieldAction,
	} = useBlueprintMutations();

	/* Imperative doc handle. The grandparent row (`FieldRow`) subscribes
	 * to the selected field entity AND receives `parentUuid` + `siblingIndex`
	 * props — so every reorder of the selected field changes at least one
	 * prop and propagates a re-render down to this header via the memo
	 * boundary. Reading the live doc with `docApi.getState()` in the
	 * render body then picks up fresh adjacency on every relevant render
	 * without forcing a reactive subscription that would also fire on
	 * unrelated field edits (label, hint, calculate). */
	const docApi = useBlueprintDocApi();

	const saveField = useSaveField(selectedUuid);
	const focusHint = useFocusHint(HEADER_FIELDS);
	const shiftHeld = useShiftKey();
	const deleteSelected = useDeleteSelectedField();

	/* ── ID field notices (errors + rename info) ── */

	type IdNotice = { severity: "error" | "info"; message: string };
	const [idNotice, setIdNotice] = useState<IdNotice | null>(null);
	const [shaking, setShaking] = useState(false);
	const idWrapperRef = useRef<HTMLDivElement>(null);
	const idInputRef = useRef<HTMLInputElement>(null);
	const idMeasureRef = useRef<HTMLSpanElement>(null);

	/** Size the ID input to its content via a hidden mirror span (same
	 *  pattern as EditableTitle). Called on mount, value change, and draft edit. */
	const syncIdWidth = useCallback(() => {
		if (idMeasureRef.current && idInputRef.current) {
			idInputRef.current.style.width = `${idMeasureRef.current.scrollWidth + 4}px`;
		}
	}, []);

	/* Auto-dismiss the notice popover after 4 seconds (matches XPathField). */
	useEffect(() => {
		if (!idNotice) return;
		const timer = setTimeout(() => setIdNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [idNotice]);

	/** Attempts the rename and returns false if blocked by a sibling conflict.
	 * On success the mutation has already been applied by the store.
	 * Rename doesn't change uuid, so no selection update is needed. */
	const validateRename = useCallback(
		(newId: string): boolean => {
			if (!selectedUuid || !newId) return false;

			const result = renameFieldAction(asUuid(selectedUuid), newId);

			/* Store blocked the rename — sibling conflict. Show shake +
			 * error popover matching the XPathField validation pattern. */
			if (result.conflict) {
				setShaking(true);
				setIdNotice({
					severity: "error",
					message: `A sibling field already has the ID "${newId}"`,
				});
				setTimeout(() => setShaking(false), 400);
				return false;
			}

			/* Rename succeeded — uuid stays the same, selection is stable.
			 * Clear the new-question highlight so subsequent edits are normal. */
			setIdNotice(null);
			clearNewField();
			return true;
		},
		[selectedUuid, renameFieldAction, clearNewField],
	);

	const idField = useCommitField({
		value: field.id,
		validate: validateRename,
		onSave: () => {},
	});

	/** Callback ref for the ID input — merges the commit hook ref with
	 *  autoFocus behavior, undo/redo focus restoration, and content-width sync. */
	const setIdInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			idInputRef.current = el;
			idField.ref(el);
			syncIdWidth();
			const shouldAutoFocus = focusHint === "id" || isNewField;
			if (el && shouldAutoFocus) {
				el.focus({ preventScroll: true });
				el.select();
			}
		},
		[idField.ref, focusHint, isNewField, syncIdWidth],
	);

	/* ── Action handlers ── */

	const handleMoveUp = useCallback(() => {
		if (!selectedUuid) return;
		const { beforeUuid } = getFieldMoveTargets(
			docApi.getState(),
			asUuid(selectedUuid),
		);
		if (beforeUuid) moveField(asUuid(selectedUuid), { beforeUuid });
	}, [selectedUuid, docApi, moveField]);

	const handleMoveDown = useCallback(() => {
		if (!selectedUuid) return;
		const { afterUuid } = getFieldMoveTargets(
			docApi.getState(),
			asUuid(selectedUuid),
		);
		if (afterUuid) moveField(asUuid(selectedUuid), { afterUuid });
	}, [selectedUuid, docApi, moveField]);

	/** Execute a cross-level move and scroll to the field at its new location. */
	const executeCrossLevel = useCallback(
		(target: CrossLevelFieldMoveTarget) => {
			if (!selectedUuid) return;
			moveField(asUuid(selectedUuid), {
				toParentUuid: target.toParentUuid,
				beforeUuid: target.beforeUuid,
				afterUuid: target.afterUuid,
			});
			/* Scroll to the field at its new position. */
			setPending(selectedUuid, "smooth", false);
		},
		[selectedUuid, moveField, setPending],
	);

	const handleDuplicate = useCallback(() => {
		if (!selectedUuid) return;
		const result = duplicateField(asUuid(selectedUuid));
		if (!result) return;
		/* Select the new clone and scroll to it. */
		setPending(result.newUuid, "smooth", false);
		select(asUuid(result.newUuid));
	}, [selectedUuid, duplicateField, setPending, select]);

	/** Delete uses the `useDeleteSelectedField` hook which handles
	 *  neighbor selection and URL update. */
	const handleDelete = useCallback(() => {
		deleteSelected();
	}, [deleteSelected]);

	if (!selectedUuid || !formUuid) return null;

	/* Compute adjacency inline so isFirst/isLast always reflect the current
	 * state. This runs on every render — see the comment on `docApi` above
	 * for why parent re-renders always cover the cases we care about. */
	const liveDoc = docApi.getState();
	const selectedUuidBranded = asUuid(selectedUuid);
	const { beforeUuid, afterUuid } = getFieldMoveTargets(
		liveDoc,
		selectedUuidBranded,
	);
	const isFirst = beforeUuid === undefined;
	const isLast = afterUuid === undefined;

	/* Cross-level (indent/outdent) targets — shown when Shift is held. */
	const { up: crossUp, down: crossDown } = getCrossLevelFieldMoveTargets(
		liveDoc,
		selectedUuidBranded,
	);

	// `kind` replaces the legacy wire `type` discriminant everywhere
	// outside the SA wire boundary. Conversion targets, icons, and human
	// labels all key off the same string value.
	const conversionTargets = getConvertibleTypes(field.kind);
	const canConvert = conversionTargets.length > 0;
	const typeIcon = fieldKindIcons[field.kind];
	const typeLabel = fieldKindLabels[field.kind] ?? field.kind;

	return (
		<div className="flex items-center justify-between px-3 py-3 border-b border-white/[0.06]">
			{/* Left: joined type icon + ID input — the icon acts as a
			 *  leading adornment inside the input's visual boundary. */}
			<div
				className="relative flex flex-col gap-1.5 min-w-0"
				data-field-id="id"
			>
				{/* Micro-label — same vocabulary as SectionLabel but inline-compact. */}
				<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/60 pl-0.5 select-none">
					ID
				</span>
				<div className="relative flex items-center">
					{/* Hidden span mirror — sizes the input to its content (EditableTitle pattern). */}
					<span
						ref={(el) => {
							idMeasureRef.current = el;
							syncIdWidth();
						}}
						className="text-sm font-mono font-medium px-2 border border-transparent absolute invisible whitespace-pre"
						aria-hidden
					>
						{idField.draft || "\u00A0"}
					</span>
					<div
						ref={idWrapperRef}
						className={`flex items-center rounded-md border outline-none transition-colors ${shaking ? "xpath-shake" : ""} ${
							idField.focused
								? "bg-nova-surface border-nova-violet/50 shadow-[0_0_0_1px_rgba(139,92,246,0.1)]"
								: "bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
						}`}
					>
						{/* Icon adornment — violet-tinted badge flush with the input */}
						<Tooltip content={typeLabel} placement="bottom">
							<span className="flex items-center justify-center w-9 h-9 shrink-0 text-nova-violet-bright border-r border-white/[0.06] rounded-l-md bg-nova-violet/10">
								{typeIcon && <Icon icon={typeIcon} width="16" height="16" />}
							</span>
						</Tooltip>
						<input
							ref={setIdInputRef}
							value={idField.draft}
							onChange={(e) => {
								idField.setDraft(e.target.value);
								if (idNotice) setIdNotice(null);
								requestAnimationFrame(syncIdWidth);
							}}
							onFocus={idField.handleFocus}
							onBlur={idField.handleBlur}
							onKeyDown={idField.handleKeyDown}
							className="min-w-[20ch] text-sm font-mono px-2 py-1.5 bg-transparent text-nova-text font-medium outline-none cursor-text"
							autoComplete="off"
							data-1p-ignore
						/>
					</div>
					<SavedCheck
						visible={idField.saved && !idField.focused}
						size={12}
						className="absolute right-1.5 shrink-0"
					/>
					{/* ID notice popover — error (conflict) or info (auto-rename).
					 *  Matches the XPathField validation popover pattern. */}
					<Popover.Root open={!!idNotice}>
						<Popover.Portal>
							<Popover.Positioner
								side="top"
								align="start"
								sideOffset={6}
								collisionPadding={8}
								anchor={idWrapperRef}
								className="z-popover-top"
							>
								<Popover.Popup className={POPOVER_POPUP_CLS}>
									<div
										role="alert"
										className={`px-2.5 py-1.5 rounded-md bg-[rgba(16,16,36,0.95)] shadow-lg max-w-xs border ${
											idNotice?.severity === "error"
												? "border-nova-rose/20"
												: "border-nova-violet/20"
										}`}
									>
										<p
											className={`text-xs font-mono leading-snug ${
												idNotice?.severity === "error"
													? "text-nova-rose"
													: "text-nova-violet-bright"
											}`}
										>
											{idNotice?.message}
										</p>
									</div>
								</Popover.Popup>
							</Popover.Positioner>
						</Popover.Portal>
					</Popover.Root>
				</div>
			</div>

			{/* Right: overflow dots menu + delete (destructive action rightmost) */}
			<div className="flex items-center gap-0.5 shrink-0">
				<Menu.Root>
					<Menu.Trigger
						aria-label="More actions"
						className="w-9 h-9 flex items-center justify-center rounded-md transition-colors text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] cursor-pointer outline-none data-[popup-open]:bg-white/[0.06]"
					>
						<Icon icon={tablerDotsVertical} width="18" height="18" />
					</Menu.Trigger>

					<Menu.Portal>
						<Menu.Positioner
							className={MENU_POSITIONER_CLS}
							sideOffset={4}
							align="end"
						>
							<Menu.Popup className={MENU_POPUP_CLS} style={{ minWidth: 200 }}>
								{/* Move Up / cross-level up (Shift swaps) */}
								<MenuItem
									icon={tablerArrowUp}
									label={
										shiftHeld
											? crossUp?.direction === "into"
												? "Move Into Group"
												: "Move Out of Group"
											: "Move Up"
									}
									shortcut={shiftHeld ? "⇧↑" : "↑"}
									disabled={shiftHeld ? !crossUp : isFirst}
									onClick={
										shiftHeld
											? () => crossUp && executeCrossLevel(crossUp)
											: handleMoveUp
									}
								/>

								{/* Move Down / cross-level down (Shift swaps) */}
								<MenuItem
									icon={tablerArrowDown}
									label={
										shiftHeld
											? crossDown?.direction === "into"
												? "Move Into Group"
												: "Move Out of Group"
											: "Move Down"
									}
									shortcut={shiftHeld ? "⇧↓" : "↓"}
									disabled={shiftHeld ? !crossDown : isLast}
									onClick={
										shiftHeld
											? () => crossDown && executeCrossLevel(crossDown)
											: handleMoveDown
									}
								/>

								<Menu.Separator className="mx-2 h-px bg-white/[0.06]" />

								{/* Convert Type — submenu with conversion targets */}
								{canConvert ? (
									<Menu.SubmenuRoot>
										<Menu.SubmenuTrigger className={MENU_ITEM_CLS}>
											<Icon
												icon={tablerArrowsExchange}
												width="16"
												height="16"
												className="text-nova-text-muted shrink-0"
											/>
											<span className="flex-1 text-left">Convert Type</span>
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
													{/* `saveField` routes the patch through `updateField`,
													 *  which expects the domain `kind` discriminant. */}
													<FieldTypeList
														types={conversionTargets}
														activeType={field.kind}
														onSelect={(next) => saveField("kind", next)}
													/>
												</Menu.Popup>
											</Menu.Positioner>
										</Menu.Portal>
									</Menu.SubmenuRoot>
								) : (
									<Tooltip content="This field type doesn't support conversion">
										<MenuItem
											icon={tablerArrowsExchange}
											label="Convert Type"
											disabled
											onClick={() => {}}
										/>
									</Tooltip>
								)}

								{/* Duplicate */}
								<MenuItem
									icon={tablerCopyPlus}
									label="Duplicate"
									shortcut={shortcutLabel("mod", "D")}
									onClick={handleDuplicate}
								/>
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>

				<Tooltip content="Delete" placement="bottom">
					<button
						type="button"
						onClick={handleDelete}
						aria-label="Delete"
						className="w-9 h-9 flex items-center justify-center rounded-md transition-colors text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10 cursor-pointer"
					>
						<Icon icon={tablerTrash} width="18" height="18" />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

// ── Reusable menu item ──────────────────────────────────────────────────

/** Single menu item with icon, label, and optional keyboard shortcut hint. */
function MenuItem({
	icon,
	label,
	shortcut,
	disabled,
	onClick,
}: {
	icon: IconifyIcon;
	label: string;
	shortcut?: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Menu.Item
			disabled={disabled}
			onClick={disabled ? undefined : onClick}
			className={disabled ? MENU_ITEM_DISABLED_CLS : MENU_ITEM_CLS}
		>
			<Icon
				icon={icon}
				width="16"
				height="16"
				className="text-nova-text-muted shrink-0"
			/>
			<span className="flex-1 text-left">{label}</span>
			{shortcut && (
				<kbd className="text-[10px] text-nova-text-muted/50 font-mono ml-4 shrink-0">
					{shortcut}
				</kbd>
			)}
		</Menu.Item>
	);
}
