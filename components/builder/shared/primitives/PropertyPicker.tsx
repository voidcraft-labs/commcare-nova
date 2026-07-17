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
import tablerCheck from "@iconify-icons/tabler/check";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerExclamationCircle from "@iconify-icons/tabler/exclamation-circle";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerSearch from "@iconify-icons/tabler/search";
import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	authorableCaseProperties,
	type CaseProperty,
	type CaseType,
	canonicalCasePropertyName,
	effectiveDataType,
} from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_POSITIONER_CLS,
} from "@/lib/styles";
import { handleMenuSearchInputKeyDown } from "@/lib/ui/menuSearchInput";
import { usePredicateEditContext } from "../editorContext";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
	propertyTypeLabel,
} from "./propertyDisplay";

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
	/** Use the authored human label instead of exposing the stored property
	 * name. Low-code authoring surfaces set this even when the persisted value is
	 * an expression reference; the stored name remains an implementation detail. */
	readonly displayLabels?: boolean;
	/** Optional create flow supplied by the owning surface. Property catalogs are
	 * derived from authored fields, so the picker never invents a mutation itself.
	 * When present, the action stays fixed below the scrolling choices. */
	readonly onCreateNew?: () => void;
	/** Friendly label for the optional fixed create action. */
	readonly createNewLabel?: string;
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
	displayLabels = false,
	onCreateNew,
	createNewLabel = "Create new information",
}: PropertyPickerProps) {
	const ctx = usePredicateEditContext();
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	const targetCaseTypeName = caseType ?? ctx.currentCaseType;
	const targetCaseType = useMemo<CaseType | undefined>(
		() => ctx.caseTypes.find((c) => c.name === targetCaseTypeName),
		[ctx.caseTypes, targetCaseTypeName],
	);

	const properties = useMemo<readonly CaseProperty[]>(() => {
		if (targetCaseType === undefined) return [];
		const authorable = authorableCaseProperties(targetCaseType.properties);
		return filter !== undefined ? authorable.filter(filter) : authorable;
	}, [targetCaseType, filter]);
	const selectedName =
		value === undefined ? undefined : canonicalCasePropertyName(value);

	const selectedKnown = useMemo(
		() =>
			selectedName !== undefined &&
			properties.some((p) => p.name === selectedName),
		[selectedName, properties],
	);
	const selectedProperty = useMemo(
		() => properties.find((property) => property.name === selectedName),
		[properties, selectedName],
	);
	const selectedDisambiguator =
		displayLabels && selectedProperty !== undefined
			? friendlyPropertyDisambiguator(selectedProperty, properties)
			: undefined;
	const visibleProperties = useMemo(() => {
		const normalizedQuery = query.trim().toLocaleLowerCase();
		if (normalizedQuery === "") return properties;

		return properties.filter((property) => {
			const disambiguator = friendlyPropertyDisambiguator(property, properties);
			const searchableText = [
				property.name,
				humanizeId(property.name),
				property.label,
				propertyDisplayLabel(property),
				disambiguator,
				propertyTypeLabel(property),
				effectiveDataType(property),
			]
				.filter((part): part is string => typeof part === "string")
				.join(" ")
				.toLocaleLowerCase();
			return searchableText.includes(normalizedQuery);
		});
	}, [properties, query]);

	const handleSelect = useCallback(
		(name: string) => {
			onChange(name);
		},
		[onChange],
	);
	const handleOpenChange = useCallback((nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) setQuery("");
	}, []);
	useLayoutEffect(() => {
		if (!open) return;
		/* Menu schedules its default first-item focus during the open commit.
		 * Queueing our focus from the owning component's layout effect runs after
		 * that setup, so typing can begin immediately without a timing race. */
		queueMicrotask(() => {
			searchInputRef.current?.focus({ preventScroll: true });
		});
	}, [open]);

	const triggerClass = [
		"group w-full flex items-center justify-between px-3 min-h-11 text-[13px] rounded-lg border transition-colors cursor-pointer text-nova-text bg-nova-deep/50",
		invalid
			? "border-nova-rose/40 hover:border-nova-rose/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const displayLabel =
		value === undefined
			? displayLabels
				? "Choose information"
				: "Pick a property"
			: displayLabels
				? selectedProperty === undefined
					? humanizeId(value) || "Unavailable information"
					: propertyDisplayLabel(selectedProperty)
				: value;
	const accessibleDisplayLabel =
		selectedDisambiguator === undefined
			? displayLabel
			: `${displayLabel}, ${selectedDisambiguator}`;

	return (
		<Menu.Root open={open} onOpenChange={handleOpenChange}>
			<Menu.Trigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`${ariaLabel}: ${accessibleDisplayLabel}`}
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
					<span className="min-w-0 text-left">
						<span
							className={`block truncate ${
								!displayLabels ? "font-mono" : "font-medium"
							} ${
								value && selectedKnown
									? "text-nova-violet-bright"
									: "text-nova-text-muted"
							}`}
						>
							{displayLabel}
						</span>
						{selectedDisambiguator !== undefined ? (
							<span className="block truncate text-[10px] font-normal text-nova-text-secondary">
								{selectedDisambiguator}
							</span>
						) : null}
					</span>
					{value && !selectedKnown && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="text-nova-rose"
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
					style={{ minWidth: "var(--anchor-width)", maxHeight: 360 }}
				>
					<Menu.Popup
						className={`${MENU_POPUP_CLS} flex max-h-[22rem] min-w-[16rem] flex-col`}
					>
						<div className="shrink-0 border-b border-white/[0.06] p-2">
							<label htmlFor={`${triggerId}-search`} className="sr-only">
								Search information
							</label>
							<div className="flex min-h-11 items-center gap-2 rounded-lg border border-white/[0.08] bg-nova-deep/70 px-3 transition-colors focus-within:border-nova-violet/40 focus-within:ring-1 focus-within:ring-nova-violet/25">
								<Icon
									icon={tablerSearch}
									width="15"
									height="15"
									className="shrink-0 text-nova-text-muted"
								/>
								<input
									ref={searchInputRef}
									id={`${triggerId}-search`}
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									onKeyDown={handleMenuSearchInputKeyDown}
									placeholder="Search information…"
									autoComplete="off"
									data-1p-ignore
									className="min-w-0 flex-1 bg-transparent text-[13px] text-nova-text outline-none placeholder:text-nova-text-muted"
								/>
							</div>
						</div>

						<div
							className="min-h-0 flex-1 overflow-y-auto p-1"
							style={{ scrollbarGutter: "stable" }}
						>
							{properties.length === 0 ? (
								<div className="px-3 py-4 text-center text-[12px] leading-relaxed text-nova-text-muted">
									No information is available yet.
								</div>
							) : visibleProperties.length === 0 ? (
								<div className="px-3 py-4 text-center text-[12px] leading-relaxed text-nova-text-muted">
									No information matches “{query.trim()}”.
								</div>
							) : (
								visibleProperties.map((p, i) => {
									const isActive = p.name === selectedName;
									const disambiguator = displayLabels
										? friendlyPropertyDisambiguator(p, properties)
										: undefined;
									const last = visibleProperties.length - 1;
									const corners =
										i === 0 && i === last
											? "rounded-lg"
											: i === 0
												? "rounded-t-lg"
												: i === last
													? "rounded-b-lg"
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
												<div
													className={
														displayLabels ? "truncate" : "font-mono truncate"
													}
												>
													{displayLabels ? propertyDisplayLabel(p) : p.name}
												</div>
												<div
													className={`text-[10px] ${
														isActive
															? "text-nova-violet-bright"
															: "text-nova-text-muted"
													}`}
												>
													{displayLabels
														? [disambiguator, propertyTypeLabel(p)]
																.filter(Boolean)
																.join(" · ")
														: effectiveDataType(p)}
												</div>
											</span>
											{isActive && (
												<Icon
													icon={tablerCheck}
													width="14"
													height="14"
													className="shrink-0 text-nova-violet-bright"
												/>
											)}
										</Menu.Item>
									);
								})
							)}
						</div>

						{onCreateNew !== undefined && (
							<div className="shrink-0 border-t border-white/[0.06] p-1">
								<Menu.Item
									onClick={onCreateNew}
									className={`${MENU_ITEM_CLS} min-h-11 rounded-lg font-medium text-nova-violet-bright`}
								>
									<Icon
										icon={tablerPlus}
										width="15"
										height="15"
										className="shrink-0"
									/>
									<span>{createNewLabel}</span>
								</Menu.Item>
							</div>
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
