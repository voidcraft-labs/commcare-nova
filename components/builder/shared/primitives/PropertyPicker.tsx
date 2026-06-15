// components/builder/shared/primitives/PropertyPicker.tsx
//
// Searchable case-property picker. Shows all properties of the
// editor's `currentCaseType` (or, optionally, a caller-supplied
// case type — used by `ExistsCard` when picking properties on the
// destination of a relation walk). The picker drives every
// property-shaped slot across the card editor: comparison `left`,
// match `property`, multi-select-contains `property`,
// within-distance `property`, between `left`, in `left`, is-null /
// is-blank `left`, etc.
//
// Implementation: Base UI Menu primitive (matches the inspector's
// `CasePropertyDropdown` pattern). Optional filter narrows the
// shown properties to a subset by data type — comparison cards
// for ordering operators (gt/lt/...) restrict to ordered types,
// multi-select-contains restricts to multi_select, etc.

"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import { useCallback, useId, useMemo, useRef } from "react";
import {
	type CaseProperty,
	type CaseType,
	effectiveDataType,
} from "@/lib/domain";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { usePredicateEditContext } from "../editorContext";

interface PropertyPickerProps {
	/** Currently selected property name, or undefined when unset. */
	readonly value: string | undefined;
	/** Fired when the user selects a property. */
	readonly onChange: (propertyName: string) => void;
	/**
	 * Override case type — when provided, the picker shows
	 * properties from this case type rather than the context's
	 * `currentCaseType`. Used by relation-walk consumers
	 * (`ExistsCard` after resolving the via's destination) to scope
	 * the picker to the destination case type.
	 */
	readonly caseType?: string;
	/**
	 * Optional filter narrowing the shown properties. Returns true
	 * for properties whose data type is admitted by the calling
	 * card. Cards that don't restrict (e.g. `eq`) pass `undefined`.
	 */
	readonly filter?: (property: CaseProperty) => boolean;
	/**
	 * Optional accessibility label override. Defaults to "Property"
	 * — cards that have multiple property slots (none today, but
	 * the contract is forward-looking) can disambiguate via the
	 * override.
	 */
	readonly ariaLabel?: string;
	/** Whether the surrounding card is reporting an error on this slot. */
	readonly invalid?: boolean;
}

/**
 * Searchable case-property picker. Reads the editor context to
 * resolve the active case type (or accepts an override via
 * `caseType`), filters the property list per the optional
 * predicate, and surfaces selection through the Base UI Menu
 * primitive.
 *
 * Renders an "(unknown)" placeholder when `value` names a property
 * that's no longer declared on the case type — keeps the editor
 * non-destructive against doc edits that remove properties out
 * from under a saved predicate.
 */
export function PropertyPicker({
	value,
	onChange,
	caseType,
	filter,
	ariaLabel = "Property",
	invalid = false,
}: PropertyPickerProps) {
	const ctx = usePredicateEditContext();
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);

	const targetCaseTypeName = caseType ?? ctx.currentCaseType;
	const targetCaseType = useMemo<CaseType | undefined>(
		() => ctx.caseTypes.find((c) => c.name === targetCaseTypeName),
		[ctx.caseTypes, targetCaseTypeName],
	);

	const properties = useMemo<readonly CaseProperty[]>(() => {
		if (targetCaseType === undefined) return [];
		return filter !== undefined
			? targetCaseType.properties.filter(filter)
			: targetCaseType.properties;
	}, [targetCaseType, filter]);

	const selectedKnown = useMemo(
		() => value !== undefined && properties.some((p) => p.name === value),
		[value, properties],
	);

	const handleSelect = useCallback(
		(name: string) => {
			onChange(name);
		},
		[onChange],
	);

	const triggerClass = [
		"group w-full flex items-center justify-between px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 hover:border-nova-rose/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const displayLabel = value ?? "Pick a property";

	return (
		<Menu.Root>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`${ariaLabel}: ${displayLabel}`}
				className={triggerClass}
			>
				<span className="flex items-center gap-1.5 min-w-0">
					<Icon
						icon={tablerDatabase}
						width="14"
						height="14"
						className={
							value && selectedKnown
								? "text-nova-violet-bright"
								: "text-nova-text-muted"
						}
					/>
					<span
						className={`truncate font-mono ${
							value && selectedKnown
								? "text-nova-violet-bright"
								: "text-nova-text-muted"
						}`}
					>
						{displayLabel}
					</span>
					{value && !selectedKnown && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="text-nova-rose/80"
							aria-label="Property is not declared on this case type"
						/>
					)}
				</span>
				<Chevron />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					className={MENU_POSITIONER_CLS}
					style={{ minWidth: "var(--anchor-width)", maxHeight: 280 }}
				>
					<Menu.Popup className={`${MENU_POPUP_CLS} max-h-72 overflow-y-auto`}>
						{properties.length === 0 ? (
							<div className={`${MENU_ITEM_BASE} text-nova-text-muted italic`}>
								No applicable properties
							</div>
						) : (
							properties.map((p, i) => {
								const isActive = p.name === value;
								const last = properties.length - 1;
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
										key={p.name}
										onClick={() => handleSelect(p.name)}
										className={`${corners} ${
											isActive
												? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
												: MENU_ITEM_CLS
										}`}
									>
										<Icon
											icon={tablerDatabase}
											width="14"
											height="14"
											className={
												isActive
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}
										/>
										<span className="flex-1 text-left min-w-0">
											<div className="font-mono truncate">{p.name}</div>
											<div
												className={`text-[10px] uppercase tracking-wider ${
													isActive
														? "text-nova-violet-bright/60"
														: "text-nova-text-muted"
												}`}
											>
												{effectiveDataType(p)}
											</div>
										</span>
									</Menu.Item>
								);
							})
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function Chevron() {
	return (
		<svg
			aria-hidden="true"
			width="10"
			height="10"
			viewBox="0 0 10 10"
			className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
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
	);
}

/**
 * Resolve the data type of a property name on a case type. Returns
 * `"text"` (CommCare's default for un-annotated properties) when
 * the property is found without a declared `data_type`, and
 * `undefined` when no such property exists. Mirrors the type
 * checker's `data_type ?? "text"` fallback so cards that gate on
 * type carry the same behavior.
 */
export function resolvePropertyDataType(
	caseTypes: readonly CaseType[],
	caseTypeName: string,
	propertyName: string,
): string | undefined {
	const ct = caseTypes.find((c) => c.name === caseTypeName);
	if (ct === undefined) return undefined;
	const prop = ct.properties.find((p) => p.name === propertyName);
	if (prop === undefined) return undefined;
	return effectiveDataType(prop);
}
