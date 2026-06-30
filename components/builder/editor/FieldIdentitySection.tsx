/**
 * FieldIdentitySection — the "Field ID" section of the right-rail field
 * inspector.
 *
 * Renders the type-icon adornment (from `fieldRegistry[field.kind].icon`),
 * the editable id input with sibling-conflict shake + popover, and the
 * actions menu (move up/down, cross-level moves with Shift, convert-type
 * submenu, duplicate). Deletion is NOT here — it rides the inspector's
 * shared `RemoveRow` at the body's last row (see `FieldInspectorBody`), the
 * one place every inspector body puts removal.
 *
 * Reads everything kind-specific from the registry:
 *   - `fieldRegistry[kind].icon`           → type icon
 *   - `fieldRegistry[kind].label`          → tooltip label
 *   - `getConvertibleTypes(kind)`          → submenu enable/disable
 *
 * No per-kind switching anywhere in this component.
 */
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
import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollIntoView } from "@/components/builder/contexts/ScrollRegistryContext";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { InspectorSection } from "@/components/builder/inspector/inspectorChrome";
import {
	REJECTION_SURFACE_CLS,
	RejectionBody,
} from "@/components/builder/RejectionNotice";
import { tablerCopyPlus } from "@/components/icons/tablerExtras";
import { Tooltip } from "@/components/ui/Tooltip";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { renameFieldIdVerdict } from "@/lib/doc/identifierVerdicts";
import {
	type CrossLevelFieldMoveTarget,
	getCrossLevelFieldMoveTargets,
	getFieldMoveTargets,
} from "@/lib/doc/navigation";
import { asUuid } from "@/lib/doc/types";
import {
	type CommitOutcome,
	type Field,
	fieldRegistry,
	getConvertibleTypes,
} from "@/lib/domain";
import { shortcutLabel } from "@/lib/platform";
import { useLocation, useSelect } from "@/lib/routing/hooks";
import {
	useCanEdit,
	useClearNewField,
	useIsNewField,
	useSessionFocusHint,
} from "@/lib/session/hooks";
import {
	MENU_ITEM_CLS,
	MENU_ITEM_DISABLED_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
	POPOVER_POPUP_CLS,
} from "@/lib/styles";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { classifyRenameOutcome } from "./renameOutcome";

interface FieldIdentitySectionProps {
	field: Field;
}

/** Track whether the Shift key is currently held. Resets on window blur
 *  and on `visibilitychange` → hidden so a tab-switch or OS-level
 *  focus change doesn't leave a phantom pressed state (e.g. user
 *  pressed Shift, cmd-tabbed away, released in another app). */
function useShiftKey(): boolean {
	const [shift, setShift] = useState(false);
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(true);
		};
		const up = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShift(false);
		};
		const clear = () => setShift(false);
		const onVisibility = () => {
			if (document.visibilityState === "hidden") setShift(false);
		};
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		window.addEventListener("blur", clear);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
			window.removeEventListener("blur", clear);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	return shift;
}

export function FieldIdentitySection({ field }: FieldIdentitySectionProps) {
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
		convertField,
		// Rename rejections render in this section's own popover, so the
		// dispatch is the inline flavor — the toast stays quiet. The menu
		// actions (move/duplicate/convert) have no contextual anchor and
		// stay on the announcing flavor.
		inline: { renameField: renameFieldAction },
	} = useBlueprintMutations();

	/* Imperative doc handle. The grandparent row (`FieldRow`) subscribes
	 * to the selected field entity AND receives `parentUuid` + `siblingIndex`
	 * props — so every reorder of the selected field changes at least one
	 * prop and propagates a re-render down to this section. Reading the live
	 * doc with `docApi.getState()` in the render body then picks up fresh
	 * adjacency on every relevant render without forcing a reactive
	 * subscription that would also fire on unrelated field edits (label,
	 * hint, calculate). */
	const docApi = useBlueprintDocApi();

	/* Raw session focus-hint. The hint is written by `useUndoRedo` and
	 * read by whichever editor owns the matching data-field-id — no
	 * editor clears it; each simply ignores non-matching values. The
	 * section consumes `focusHint === "id"` by auto-focusing + selecting
	 * the ID input on mount. */
	const focusHint = useSessionFocusHint();
	const shiftHeld = useShiftKey();
	const canEdit = useCanEdit();

	/* ── ID field notices (errors + rename info) ── */

	type IdNotice = { severity: "error" | "info"; message: string };
	const [idNotice, setIdNotice] = useState<IdNotice | null>(null);
	const [shaking, setShaking] = useState(false);
	const idWrapperRef = useRef<HTMLDivElement>(null);
	const idInputRef = useRef<HTMLInputElement>(null);

	/* Auto-dismiss the notice popover after 4 seconds so a stale error
	 * doesn't shadow a subsequent successful rename. Cleanup cancels the
	 * timer if the consumer unmounts mid-window or a fresh notice arrives. */
	useEffect(() => {
		if (!idNotice) return;
		const timer = setTimeout(() => setIdNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [idNotice]);

	/** Runs the shared identifier verdict and, on a clean verdict,
	 * dispatches the rename. Rename doesn't change uuid, so no selection
	 * update is needed. The verdict (`renameFieldIdVerdict`) is the same
	 * one the SA tools enforce — XML-name legality, the reserved
	 * `__nova_` prefix, the case-property length cap, and the peer-aware
	 * sibling-conflict scan — so UI and agent renames can't drift. The
	 * outcome classification is owned by `classifyRenameOutcome` so the
	 * branching is testable without mounting the section.
	 *
	 * Wired as `useCommitField`'s `onSave` (NOT `validate`): an
	 * `ok: false` return runs the hook's draft-preserving restore — the
	 * typed id stays in the input alongside the shake + popover — where
	 * a `validate` false would snap the input back to the old id. */
	const commitRename = useCallback(
		(newId: string): CommitOutcome | undefined => {
			if (!selectedUuid) return undefined;

			const verdict = renameFieldIdVerdict({
				doc: docApi.getState(),
				fieldUuid: asUuid(selectedUuid),
				newId,
			});
			const outcome = classifyRenameOutcome({ newId, verdict });

			switch (outcome.kind) {
				case "noop":
					/* Hardening only — empty/no-op commits short-circuit inside
					 * the hook before `onSave` fires. A messageless rejection
					 * reads as a silent revert. */
					return { ok: false, messages: [] };
				case "rejected":
					/* The verdict blocked the rename — an illegal, reserved,
					 * over-long, or sibling-conflicting id. Surface it with a
					 * quick shake on the input wrapper plus an error popover
					 * anchored to it. The `onAnimationEnd` handler on the
					 * wrapper clears `shaking` when the CSS keyframe
					 * completes. */
					setShaking(true);
					setIdNotice({
						severity: "error",
						message: outcome.message,
					});
					return { ok: false, messages: [outcome.message] };
				case "success": {
					/* Verdict clean — dispatch the rename (the store re-runs
					 * the conflict scan as its own backstop, and the commit
					 * gate can still refuse for findings only the whole-doc
					 * validator sees). Uuid stays the same, selection is
					 * stable. */
					const result = renameFieldAction(asUuid(selectedUuid), newId);
					if (result.rejected && result.rejected.length > 0) {
						/* The commit gate refused — same shake + popover chrome
						 * as an identifier rejection, with the gate's own
						 * finding. */
						setShaking(true);
						setIdNotice({
							severity: "error",
							message: result.rejected[0],
						});
						return { ok: false, messages: result.rejected };
					}
					/* Clear the new-field highlight so subsequent edits are
					 * normal. */
					setIdNotice(null);
					clearNewField();
					return undefined;
				}
			}
		},
		[selectedUuid, docApi, renameFieldAction, clearNewField],
	);

	const idField = useCommitField({
		value: field.id,
		// `commitRename` owns the verdict + dispatch and returns the
		// outcome — a refusal rides the hook's draft-preserving restore.
		onSave: commitRename,
	});

	/** Callback ref for the ID input — merges the commit hook ref with
	 *  autoFocus behavior and undo/redo focus restoration. */
	const setIdInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			idInputRef.current = el;
			idField.ref(el);
			/* Auto-focus gate. `focusHint === "id"` is the undo/redo
			 * restoration path; `isNewField` covers the just-inserted
			 * case where the user expects to immediately type an id
			 * rather than clicking into the input first. */
			const shouldAutoFocus = focusHint === "id" || isNewField;
			if (el && shouldAutoFocus) {
				el.focus({ preventScroll: true });
				el.select();
			}
		},
		[idField.ref, focusHint, isNewField],
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

	/* Icon + label + conversion targets all resolve from the registry —
	 * the single source of truth for per-kind metadata. No parallel map
	 * lookup, no fallback string: every kind in `fieldRegistry` carries
	 * both an icon and a label by construction. */
	const meta = fieldRegistry[field.kind];
	const typeIcon = meta.icon;
	const typeLabel = meta.label;
	const conversionTargets = getConvertibleTypes(field.kind);
	const canConvert = conversionTargets.length > 0;

	return (
		<InspectorSection label="Field ID">
			<div className="flex items-center gap-2" data-field-id="id">
				{/* Joined type icon + id input — the icon is a leading adornment
				 *  inside the input's visual boundary, the recessed well every
				 *  other rail input uses. */}
				<div className="relative flex-1 min-w-0">
					<div
						ref={idWrapperRef}
						onAnimationEnd={(e) => {
							if (e.animationName === "shake") setShaking(false);
						}}
						className={`flex items-stretch min-h-11 rounded-lg border outline-none transition-colors ${shaking ? "xpath-shake" : ""} ${
							idField.focused
								? "bg-nova-deep/50 border-nova-violet/40 ring-1 ring-nova-violet/30"
								: "bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
						}`}
					>
						{/* Icon adornment — violet-tinted badge flush with the input */}
						<Tooltip content={typeLabel} placement="bottom">
							<span className="flex items-center justify-center w-10 shrink-0 text-nova-violet-bright border-r border-white/[0.06] rounded-l-lg bg-nova-violet/10">
								<Icon icon={typeIcon} width="16" height="16" />
							</span>
						</Tooltip>
						<input
							ref={setIdInputRef}
							value={idField.draft}
							onChange={(e) => {
								idField.setDraft(e.target.value);
								if (idNotice) setIdNotice(null);
							}}
							onFocus={idField.handleFocus}
							onBlur={idField.handleBlur}
							onKeyDown={idField.handleKeyDown}
							className="flex-1 min-w-0 text-[13px] font-mono px-3 bg-transparent text-nova-text font-medium outline-none cursor-text"
							autoComplete="off"
							data-1p-ignore
						/>
						<SavedCheck
							visible={idField.saved && !idField.focused}
							size={12}
							className="self-center mr-2 shrink-0"
						/>
					</div>
					{/* ID notice popover — anchored to the input wrapper, shown
					 *  while `idNotice` is non-null. Carries either an error
					 *  (sibling conflict) or info (auto-rename) message; the
					 *  4-second dismissal timer upstream keeps stale notices
					 *  from lingering past a successful retry. */}
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
									{idNotice?.severity === "error" ? (
										<div
											role="alert"
											className={`px-3 py-2.5 max-w-sm ${REJECTION_SURFACE_CLS}`}
										>
											<RejectionBody message={idNotice.message} />
										</div>
									) : (
										/* Info notices (auto-rename after a cross-level
										 * move) keep the violet register — nothing was
										 * refused, the system did something on the
										 * user's behalf. */
										<div
											role="alert"
											className="px-2.5 py-1.5 rounded-md bg-nova-overlay shadow-lg max-w-xs border border-nova-violet/20"
										>
											<p className="text-xs font-mono leading-snug text-nova-violet-bright">
												{idNotice?.message}
											</p>
										</div>
									)}
								</Popover.Popup>
							</Popover.Positioner>
						</Popover.Portal>
					</Popover.Root>
				</div>

				{/* Actions overflow menu — move / convert / duplicate. Hidden for
				 *  a view-only Project member: every item is a gated mutation. */}
				{canEdit && (
					<Menu.Root>
						<Menu.Trigger
							aria-label="Field actions"
							className="shrink-0 size-11 grid place-items-center rounded-lg border border-white/[0.06] text-nova-text-muted hover:text-nova-text hover:border-nova-violet/30 transition-colors cursor-pointer outline-none data-[popup-open]:bg-white/[0.06]"
						>
							<Icon icon={tablerDotsVertical} width="18" height="18" />
						</Menu.Trigger>

						<Menu.Portal>
							<Menu.Positioner
								className={MENU_POSITIONER_CLS}
								sideOffset={4}
								align="end"
							>
								<Menu.Popup
									className={MENU_POPUP_CLS}
									style={{ minWidth: 200 }}
								>
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

									{/* Convert Type — submenu with conversion targets. When the
									 *  current kind has no convert targets, the trigger
									 *  collapses to a disabled item with an explanatory
									 *  tooltip rather than disappearing, so the menu's
									 *  vertical rhythm stays stable across kinds and the
									 *  user learns *why* the affordance is unavailable for
									 *  this type rather than wondering whether they missed
									 *  it. */}
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
													className="text-nova-text-muted shrink-0 -mr-0.5"
												/>
											</Menu.SubmenuTrigger>
											<Menu.Portal>
												<Menu.Positioner
													className={MENU_SUBMENU_POSITIONER_CLS}
													sideOffset={4}
												>
													<Menu.Popup className={MENU_POPUP_CLS}>
														{/* `convertField` dispatches a single atomic mutation:
														 *  the reducer swaps the kind and reconciles per-kind
														 *  properties via `fieldSchema`, keeping undo history
														 *  and event logging clean. */}
														{conversionTargets.map((target) => {
															const targetMeta = fieldRegistry[target];
															return (
																<MenuItem
																	key={target}
																	icon={targetMeta.icon}
																	label={targetMeta.label}
																	onClick={() =>
																		convertField(asUuid(selectedUuid), target)
																	}
																/>
															);
														})}
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
				)}
			</div>
		</InspectorSection>
	);
}

// ── Reusable menu item ──────────────────────────────────────────────────

/** Single menu item with icon, label, and optional keyboard shortcut hint.
 *  `onClick` is optional so disabled items can omit it — the helper drops
 *  any handler whenever `disabled` is true regardless of what callers pass. */
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
	onClick?: () => void;
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
				<kbd className="text-[10px] text-nova-text-muted font-mono ml-4 shrink-0">
					{shortcut}
				</kbd>
			)}
		</Menu.Item>
	);
}
