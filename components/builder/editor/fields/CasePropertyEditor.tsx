/**
 * CasePropertyEditor — declarative editor for the `case_property` key.
 *
 * Reads the selected form's module to discover writable case types
 * (the module's own type plus any direct child types) and renders a
 * Base UI menu to pick one. Renders nothing when:
 *   - no form is selected (no context to write against),
 *   - the field can't write to any case type AND isn't a case_name
 *     question.
 *
 * The dropdown widget used to live at
 * `components/builder/contextual/CasePropertyDropdown.tsx`. That file
 * is folded in here as a private internal because this editor is the
 * only remaining consumer. The `MEDIA_TYPES` set also migrates here
 * for the same reason — it's only used to disable the dropdown for
 * binary kinds.
 */

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerCircleOff from "@iconify-icons/tabler/circle-off";
import tablerDatabase from "@iconify-icons/tabler/database";
import { useCallback, useId, useMemo, useRef } from "react";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { CaseType, Field, FieldKind } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";

/** Binary/media kinds whose value can't be a case property — disable the dropdown. */
const MEDIA_TYPES = new Set<FieldKind>([
	"image",
	"audio",
	"video",
	"signature",
]);

/**
 * Writable case types for a module: the module's own type plus every
 * child case type that declares the module's type as its parent.
 */
function getModuleCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): string[] {
	if (!caseType) return [];
	const result = [caseType];
	for (const ct of caseTypes) {
		if (ct.parent_type === caseType) result.push(ct.name);
	}
	return result;
}

interface CasePropertyDropdownProps {
	value: string | undefined;
	isCaseName: boolean;
	disabled: boolean;
	caseTypes: string[];
	onChange: (caseType: string | null) => void;
	/** When true, the trigger button takes focus on mount (undo/redo restore). */
	autoFocus?: boolean;
}

/**
 * Base UI menu-backed dropdown for the case-property selection.
 *
 * Exported so the legacy ContextualEditorData can reuse the widget
 * during the transition. It's the only external consumer — once
 * that file is deleted in a later task, this export can be inlined
 * as a private helper.
 */
export function CasePropertyDropdown({
	value,
	isCaseName,
	autoFocus,
	disabled,
	caseTypes,
	onChange,
}: CasePropertyDropdownProps) {
	const isInteractive = !disabled && !isCaseName;
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);

	// Compose autoFocus — a ref callback fires once on mount, which is
	// what we need for undo/redo focus restoration. An effect would run
	// after the focus hint was already consumed.
	const composedTriggerRef = useCallback(
		(el: HTMLButtonElement | null) => {
			(triggerRef as React.MutableRefObject<HTMLButtonElement | null>).current =
				el;
			if (el && autoFocus) el.focus({ preventScroll: true });
		},
		[autoFocus],
	);

	const handleSelect = useCallback(
		(caseType: string | null) => {
			onChange(caseType);
		},
		[onChange],
	);

	const items = useMemo(() => {
		const result: { key: string; label: string; description: string }[] = [
			{
				key: "__none__",
				label: "None",
				description: "Don't save to a case",
			},
		];
		for (const ct of caseTypes) {
			result.push({
				key: ct,
				label: ct,
				description:
					ct === caseTypes[0] ? "Primary case type" : "Child case type",
			});
		}
		return result;
	}, [caseTypes]);

	// Hide entirely when no case types exist and this isn't a case_name
	// question. CasePropertyEditor applies the same gate higher up, but
	// keeping it here defends the widget as a standalone primitive.
	if (caseTypes.length === 0 && !isCaseName) return null;

	const activeKey = value ?? "__none__";
	const displayLabel = value ?? "None";

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block"
			>
				Saves to
			</label>

			{isInteractive ? (
				<Menu.Root>
					<Menu.Trigger
						ref={composedTriggerRef}
						id={triggerId}
						aria-label={`Saves to: ${displayLabel}`}
						className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
					>
						<span
							className={
								value ? "text-nova-violet-bright" : "text-nova-text-muted"
							}
						>
							{displayLabel}
						</span>
						<svg
							aria-hidden="true"
							width="10"
							height="10"
							viewBox="0 0 10 10"
							className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
						>
							<path
								d="M2 3.5L5 6.5L8 3.5"
								stroke="currentColor"
								strokeWidth="1.2"
								fill="none"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</Menu.Trigger>

					<Menu.Portal>
						<Menu.Positioner
							side="bottom"
							align="start"
							sideOffset={4}
							anchor={triggerRef}
							className={MENU_POSITIONER_CLS}
							style={{ minWidth: "var(--anchor-width)" }}
						>
							<Menu.Popup className={MENU_POPUP_CLS}>
								{items.map((item, i) => {
									const isActive = item.key === activeKey;
									const last = items.length - 1;
									const corners =
										i === 0 && i === last
											? "rounded-xl"
											: i === 0
												? "rounded-t-xl"
												: i === last
													? "rounded-b-xl"
													: "";

									return (
										<Menu.Item
											key={item.key}
											onClick={() =>
												handleSelect(item.key === "__none__" ? null : item.key)
											}
											className={`${corners} ${
												isActive
													? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
													: MENU_ITEM_CLS
											}`}
										>
											<Icon
												icon={
													item.key === "__none__"
														? tablerCircleOff
														: tablerDatabase
												}
												width="16"
												height="16"
												className={
													isActive
														? "text-nova-violet-bright"
														: "text-nova-text-muted"
												}
											/>
											<span className="flex-1 text-left">
												<div>{item.label}</div>
												<div
													className={`text-xs leading-tight ${
														isActive
															? "text-nova-violet-bright/60"
															: "text-nova-text-muted"
													}`}
												>
													{item.description}
												</div>
											</span>
										</Menu.Item>
									);
								})}
							</Menu.Popup>
						</Menu.Positioner>
					</Menu.Portal>
				</Menu.Root>
			) : (
				// Static trigger when non-interactive (disabled or case_name).
				// Rendering an inert button (rather than skipping entirely)
				// keeps the row present so the label doesn't reflow away.
				<button
					type="button"
					ref={composedTriggerRef}
					id={triggerId}
					aria-label={`Saves to: ${displayLabel}`}
					disabled
					className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors ${
						isCaseName && value ? "opacity-70" : "opacity-50"
					} cursor-not-allowed text-nova-text bg-nova-deep/50 border-white/[0.06]`}
				>
					<span
						className={
							value ? "text-nova-violet-bright" : "text-nova-text-muted"
						}
					>
						{displayLabel}
					</span>
				</button>
			)}
		</div>
	);
}

/**
 * Declarative adapter around CasePropertyDropdown. Resolves writable
 * case types from the URL-selected form and marshals the generic
 * `onChange` into the dropdown's `string | null` shape (null clears).
 *
 * The `as F["case_property" & keyof F]` cast is the registry-narrowing
 * invariant: only kinds that carry `case_property` wire this component
 * in their editor schema, and on those kinds the key's type is exactly
 * `string | undefined`.
 */
export function CasePropertyEditor<F extends Field>(
	props: FieldEditorComponentProps<F, "case_property" & keyof F>,
) {
	const { field, value, onChange, autoFocus } = props;
	const ctx = useSelectedFormContext();
	const caseTypes = useCaseTypes();

	if (!ctx) return null;

	const writableCaseTypes = getModuleCaseTypes(ctx.module.caseType, caseTypes);
	const isCaseName = field.id === "case_name";

	// Hide entirely when the field has no case-writing affordance at
	// all. Case-name questions always render because the module guarantees
	// a primary type, but for every other field the section should
	// collapse when no writable types exist.
	if (!isCaseName && writableCaseTypes.length === 0) return null;

	return (
		<div data-field-id="case_property_on">
			<CasePropertyDropdown
				value={typeof value === "string" ? value : undefined}
				isCaseName={isCaseName}
				disabled={MEDIA_TYPES.has(field.kind)}
				caseTypes={writableCaseTypes}
				onChange={(caseType) =>
					onChange((caseType ?? undefined) as F["case_property" & keyof F])
				}
				autoFocus={autoFocus}
			/>
		</div>
	);
}
