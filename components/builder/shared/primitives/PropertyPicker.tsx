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
// Implementation: Nova's shadcn dropdown-menu primitive. Optional filter narrows the
// shown properties to a subset by data type — comparison cards
// for ordering operators (gt/lt/...) restrict to ordered types,
// multi-select-contains restricts to multi_select, etc.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerCheck from "@iconify-icons/tabler/check";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
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
import { Button } from "@/components/shadcn/button";
import {
	DropdownMenu,
	DropdownMenuItem,
	DropdownMenuPopup,
	DropdownMenuPortal,
	DropdownMenuPositioner,
	DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import { Input } from "@/components/shadcn/input";
import {
	authorableCaseProperties,
	type CaseProperty,
	type CaseType,
	canonicalCasePropertyName,
	effectiveDataType,
} from "@/lib/domain";
import { humanizeId } from "@/lib/domain/idSlug";
import { handleMenuSearchInputKeyDown } from "@/lib/ui/menuSearchInput";
import {
	type ExpressionChangeAdmission,
	usePredicateEditContext,
} from "../editorContext";
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
	/** Optional whole-rule admission for a concrete property choice. The active
	 * saved choice remains available for legacy repair even when the oracle
	 * reports that authoring the same shape from a clean rule is unsupported. */
	readonly admit?: (property: CaseProperty) => ExpressionChangeAdmission;
	/**
	 * Optional accessibility label override. Defaults to "Case information"
	 * — cards that have multiple property slots (none today, but
	 * the contract is forward-looking) can disambiguate via the
	 * override.
	 */
	readonly ariaLabel?: string;
	/** Whether the surrounding card is reporting an error on this slot. */
	readonly invalid?: boolean;
	/** Optional create flow supplied by the owning surface. Property catalogs are
	 * derived from authored fields, so the picker never invents a mutation itself.
	 * When present, the action stays fixed below the scrolling choices. */
	readonly onCreateNew?: () => void;
	/** Friendly label for the optional fixed create action. */
	readonly createNewLabel?: string;
	/** Optional progressive action fixed below the property choices. Use this
	 * for a related setting that should stay out of the ordinary selection path
	 * while remaining discoverable from the same information picker. */
	readonly footerAction?: {
		readonly label: string;
		readonly description?: string;
		readonly icon: IconifyIcon;
		readonly onSelect: () => void;
	};
}

/**
 * Searchable case-property picker. Reads the editor context to
 * resolve the active case type (or accepts an override via
 * `caseType`), filters the property list per the optional
 * predicate, and surfaces selection through Nova's shared shadcn
 * dropdown primitive.
 *
 * Renders a friendly unavailable state when `value` names a property
 * that's no longer declared on the case type — keeps the editor
 * non-destructive against doc edits that remove properties out
 * from under a saved predicate.
 */
export function PropertyPicker({
	value,
	onChange,
	caseType,
	filter,
	admit,
	ariaLabel = "Case information",
	invalid = false,
	onCreateNew,
	createNewLabel = "Create new information",
	footerAction,
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
		selectedProperty === undefined
			? undefined
			: friendlyPropertyDisambiguator(selectedProperty, properties);
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
		"group flex h-auto min-h-11 w-full items-center justify-between rounded-lg border bg-nova-deep/50 px-3 py-2.5 text-[14px] text-nova-text whitespace-normal transition-colors cursor-pointer",
		invalid
			? "border-nova-rose/40 hover:border-nova-rose/60"
			: "border-white/[0.06] hover:border-nova-violet/30",
	].join(" ");

	const displayLabel =
		value === undefined
			? "Choose information"
			: selectedProperty === undefined
				? "Unavailable information"
				: propertyDisplayLabel(selectedProperty);
	const accessibleDisplayLabel =
		selectedDisambiguator === undefined
			? displayLabel
			: `${displayLabel}, ${selectedDisambiguator}`;

	return (
		<DropdownMenu open={open} onOpenChange={handleOpenChange}>
			<DropdownMenuTrigger
				ref={triggerRef}
				id={triggerId}
				aria-label={`${ariaLabel}: ${accessibleDisplayLabel}`}
				render={
					<Button
						type="button"
						variant="outline"
						size="xl"
						className={triggerClass}
					/>
				}
			>
				<span className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
					<Icon
						icon={tablerDatabase}
						width="14"
						height="14"
						className={`mt-0.5 shrink-0 ${
							value && selectedKnown
								? "text-nova-violet-bright"
								: "text-nova-text-muted"
						}`}
					/>
					<span className="min-w-0 flex-1 text-left">
						<span
							className={`block break-words font-medium ${
								value && selectedKnown
									? "text-nova-violet-bright"
									: "text-nova-text-muted"
							}`}
						>
							{displayLabel}
						</span>
						{selectedDisambiguator !== undefined ? (
							<span className="block break-words text-[12px] font-normal leading-4 text-nova-text-secondary">
								{selectedDisambiguator}
							</span>
						) : null}
					</span>
					{value && !selectedKnown && (
						<Icon
							icon={tablerExclamationCircle}
							width="14"
							height="14"
							className="mt-0.5 shrink-0 text-nova-rose"
							aria-label="This information is no longer available"
						/>
					)}
				</span>
				<Chevron />
			</DropdownMenuTrigger>
			<DropdownMenuPortal>
				<DropdownMenuPositioner
					side="bottom"
					align="start"
					sideOffset={4}
					anchor={triggerRef}
					style={{ minWidth: "var(--anchor-width)", maxHeight: 360 }}
				>
					<DropdownMenuPopup className="flex max-h-[min(22rem,var(--available-height))] min-w-0 flex-col overflow-hidden p-0">
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
								<Input
									ref={searchInputRef}
									id={`${triggerId}-search`}
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									onKeyDown={handleMenuSearchInputKeyDown}
									placeholder="Search information"
									autoComplete="off"
									data-1p-ignore
									className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[14px] text-nova-text shadow-none outline-none placeholder:text-nova-text-muted focus-visible:border-transparent focus-visible:ring-0 md:text-[14px] dark:bg-transparent"
								/>
							</div>
						</div>

						<div className="min-h-0 flex-1 overflow-y-auto p-1">
							{properties.length === 0 ? (
								<div className="px-3 py-4 text-center text-[13px] leading-5 text-nova-text-muted">
									No information is available yet
								</div>
							) : visibleProperties.length === 0 ? (
								<div
									role="status"
									aria-live="polite"
									className="px-3 py-5 text-center"
								>
									<p className="text-sm font-medium text-nova-text">
										No matching information
									</p>
									<p className="mt-1 text-xs leading-relaxed text-nova-text-muted">
										Try a different search
									</p>
								</div>
							) : (
								visibleProperties.map((p) => {
									const isActive = p.name === selectedName;
									const verdict = admit?.(p) ?? { admitted: true as const };
									const admitted = isActive || verdict.admitted;
									const disambiguator = friendlyPropertyDisambiguator(
										p,
										properties,
									);
									return (
										<DropdownMenuItem
											key={p.name}
											disabled={!admitted}
											onClick={() => handleSelect(p.name)}
											className={
												isActive
													? "bg-nova-violet/10 text-nova-violet-bright"
													: ""
											}
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
												<div className="break-words">
													{propertyDisplayLabel(p)}
												</div>
												<div
													className={`text-[12px] leading-4 ${
														isActive
															? "text-nova-violet-bright"
															: "text-nova-text-muted"
													}`}
												>
													{[disambiguator, propertyTypeLabel(p)]
														.filter(Boolean)
														.join(" · ")}
												</div>
												{!admitted && verdict.admitted === false ? (
													<div className="mt-0.5 break-words text-[12px] leading-4 text-nova-text-muted">
														{verdict.reason}
													</div>
												) : null}
											</span>
											{isActive && (
												<Icon
													icon={tablerCheck}
													width="14"
													height="14"
													className="shrink-0 text-nova-violet-bright"
												/>
											)}
										</DropdownMenuItem>
									);
								})
							)}
						</div>

						{(footerAction !== undefined || onCreateNew !== undefined) && (
							<div className="shrink-0 border-t border-white/[0.06] p-1">
								{footerAction !== undefined && (
									<DropdownMenuItem onClick={footerAction.onSelect}>
										<Icon
											icon={footerAction.icon}
											width="15"
											className="shrink-0 text-nova-text-muted"
										/>
										<span className="min-w-0 flex-1 text-left">
											<span className="block break-words font-medium">
												{footerAction.label}
											</span>
											{footerAction.description !== undefined && (
												<span className="mt-0.5 block break-words text-xs leading-relaxed text-nova-text-muted">
													{footerAction.description}
												</span>
											)}
										</span>
									</DropdownMenuItem>
								)}
								{onCreateNew !== undefined && (
									<DropdownMenuItem
										onClick={onCreateNew}
										className="min-h-11 font-medium text-nova-violet-bright"
									>
										<Icon
											icon={tablerPlus}
											width="15"
											height="15"
											className="shrink-0"
										/>
										<span>{createNewLabel}</span>
									</DropdownMenuItem>
								)}
							</div>
						)}
					</DropdownMenuPopup>
				</DropdownMenuPositioner>
			</DropdownMenuPortal>
		</DropdownMenu>
	);
}

function Chevron() {
	return (
		<Icon
			icon={tablerChevronDown}
			aria-hidden="true"
			width="14"
			height="14"
			className="shrink-0 text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
		/>
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
