// components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx
//
// Properties for the search panel itself — what the search canvas's
// panel chrome selects. Owns every Search-screen `caseSearchConfig` slot:
//
//   1. `searchScreenTitle` — title above the search inputs.
//   2. `searchScreenSubtitle` — markdown subtitle below the title.
//   3. `searchButtonLabel` — label on the search button.
//   4. `searchButtonDisplayCondition` — optional predicate gating the
//      button's visibility at runtime. This rail only summarizes it; the
//      center Search workbench is its one editing surface.
// Assigned-case availability is edited only in Results beside the other
// Cases available rules. This inspector owns Search-screen behavior only.
//
// `caseSearchConfig` is OPTIONAL on the Module schema. A module
// without case-search authored receives an empty config the moment
// any slot takes its first value; the per-slot mutators route through
// the shared `setOptionalSlot` helper so untouched siblings flow
// through unchanged AND a clear emits a destructured drop (the slot
// key is absent on the next config, not a `key: undefined` assignment
// that would land as an own enumerable property under
// `Object.assign(mod, patch)`).

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { OptionalTextRow } from "@/components/builder/inspector/OptionalTextRow";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	type CaseSearchConfig,
	type CaseType,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { summarizeFilter } from "../predicateSummary";

export interface SearchPanelInspectorBodyProps {
	/** Current case-search configuration. `undefined` means the module
	 *  has no caseSearchConfig authored yet — first edit seeds the slot
	 *  with the changed sub-slot on top of an otherwise-empty config. */
	readonly value: CaseSearchConfig | undefined;
	readonly onChange: (next: CaseSearchConfig) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	/** Search-input declarations available while authoring the condition. */
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/** False when there are no input fields, so Search-screen copy never renders. */
	readonly hasVisibleSearchScreen?: boolean;
	/** Whether a real Search action exists. Owner-only availability deliberately
	 * passes false even though it shares the legacy storage bag. */
	readonly hasSearchAction?: boolean;
	/** True only for the actual web auto-launch shape (effective availability
	 * filter + no inputs), not merely because a search config marker exists. */
	readonly opensResultsAutomatically?: boolean;
	/** Opens the Search-action availability condition in the workbench. */
	readonly onEditDisplayCondition: (focusNewCondition?: boolean) => void;
	/** The Search-action condition is invalid and needs repair. */
	readonly searchSettingsHasError?: boolean;
}

export function SearchPanelInspectorBody({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	hasVisibleSearchScreen = true,
	hasSearchAction,
	opensResultsAutomatically = false,
	onEditDisplayCondition,
	searchSettingsHasError = false,
}: SearchPanelInspectorBodyProps) {
	const setTitle = (next: string | undefined) => {
		const authored = next === DEFAULT_CASE_SEARCH_TITLE ? undefined : next;
		// Clearing an untouched default should only restore that default in the
		// control; it must not materialize an empty search-settings object.
		if (authored === undefined && value?.searchScreenTitle === undefined)
			return;
		onChange(setOptionalSlot(value, "searchScreenTitle", authored));
	};
	const setSubtitle = (next: string | undefined) =>
		onChange(setOptionalSlot(value, "searchScreenSubtitle", next));
	const setButtonLabel = (next: string | undefined) => {
		const authored =
			next === DEFAULT_CASE_SEARCH_BUTTON_LABEL ? undefined : next;
		if (authored === undefined && value?.searchButtonLabel === undefined)
			return;
		onChange(setOptionalSlot(value, "searchButtonLabel", authored));
	};
	const setDisplayCondition = (next: Predicate | undefined) =>
		onChange(setOptionalSlot(value, "searchButtonDisplayCondition", next));
	const searchActionIsActive =
		hasSearchAction ??
		(value !== undefined && value.searchActionEnabled !== false);
	const advancedIsActive =
		value?.searchButtonDisplayCondition !== undefined ||
		(!hasVisibleSearchScreen &&
			(searchActionIsActive || value?.searchButtonLabel !== undefined));

	return (
		<>
			{hasVisibleSearchScreen ? (
				<>
					<OptionalTextRow
						label="Title"
						hint="Shown above the search fields"
						// The worker sees this real default, so the author should edit that
						// same value rather than infer it from disposable placeholder copy.
						value={value?.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE}
						onCommit={setTitle}
					/>

					<OptionalMarkdownRow
						label="Subtitle"
						hint="Shown below the title"
						value={value?.searchScreenSubtitle}
						onCommit={setSubtitle}
					/>

					<OptionalTextRow
						label="Search button label"
						hint="Use a short action, such as Search or Find cases"
						value={value?.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL}
						onCommit={setButtonLabel}
						maxGraphemes={32}
					/>
				</>
			) : (
				<p className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary">
					{opensResultsAutomatically
						? "There’s nothing to fill in. Results opens automatically when Search is available, and Cases available decides what people see."
						: searchActionIsActive
							? "There’s nothing to fill in. Search is available from Results, so people can continue without entering search information."
							: "People can browse the case list without filling in a Search screen. Add Search from Results when they need a separate continue action."}
				</p>
			)}

			<AdvancedSearchSettings
				active={advancedIsActive}
				attention={searchSettingsHasError}
				label="More settings"
				defaultOpen={false}
			>
				{!hasVisibleSearchScreen && (
					<OptionalTextRow
						label="Search action label"
						hint="Used when the list offers a Search action"
						value={value?.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL}
						onCommit={setButtonLabel}
						maxGraphemes={32}
					/>
				)}
				<SearchDisplayConditionSetting
					title="When Search is available"
					description="Offer the Search action only when a condition matches"
					value={value?.searchButtonDisplayCondition}
					onChange={setDisplayCondition}
					onEdit={onEditDisplayCondition}
					alwaysSummary="The Search action is always available"
					clearLabel="Always allow Search"
					clearTitle="Search will always be available"
					clearConsequence="The saved condition will be removed. The Search action will be available whenever this case list can search."
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
				/>
			</AdvancedSearchSettings>
		</>
	);
}

function SearchDisplayConditionSetting({
	title,
	description,
	value,
	onChange,
	onEdit,
	alwaysSummary,
	clearLabel,
	clearTitle,
	clearConsequence,
	caseTypes,
	currentCaseType,
	knownInputs,
}: {
	readonly title: string | undefined;
	readonly description: string;
	readonly value: Predicate | undefined;
	readonly onChange: (next: Predicate | undefined) => void;
	readonly onEdit: (focusNewCondition?: boolean) => void;
	readonly alwaysSummary: string;
	readonly clearLabel: string;
	readonly clearTitle: string;
	readonly clearConsequence: string;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs: readonly EditorSearchInputDecl[];
}) {
	const addButtonRef = useRef<HTMLButtonElement>(null);
	const clearButtonRef = useRef<HTMLButtonElement>(null);
	const focusAddAfterClearRef = useRef(false);
	const [confirmingClear, setConfirmingClear] = useState(false);
	useEffect(() => {
		if (value !== undefined || !focusAddAfterClearRef.current) return;
		const frame = requestAnimationFrame(() => {
			addButtonRef.current?.focus();
			focusAddAfterClearRef.current = false;
		});
		return () => cancelAnimationFrame(frame);
	}, [value]);

	const add = () => {
		onChange(
			firstComparisonDefault({ caseTypes, currentCaseType, knownInputs }),
		);
		onEdit(true);
	};
	return (
		<>
			<section className="space-y-3">
				<div>
					{title !== undefined && (
						<h3 className="text-[13px] font-medium leading-5 text-nova-text-secondary">
							{title}
						</h3>
					)}
					<p
						className={`${title === undefined ? "" : "mt-1 "}text-[13px] leading-relaxed text-nova-text-muted`}
					>
						{description}
					</p>
				</div>
				{value === undefined ? (
					<Button
						ref={addButtonRef}
						type="button"
						variant="outline"
						size="xl"
						onClick={add}
						className="w-full border-dashed border-white/[0.10] bg-transparent text-[14px] text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
					>
						Add condition
					</Button>
				) : (
					<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
						<p className="text-[13px] leading-relaxed text-nova-text-secondary">
							{summarizeFilter(value, {
								caseTypes,
								currentCaseType,
								knownInputs,
							}) ?? alwaysSummary}
						</p>
						<div className="mt-3 flex gap-2">
							<Button
								data-search-condition-origin
								type="button"
								variant="outline"
								size="xl"
								onClick={() => onEdit()}
								className="min-w-0 flex-1 border-white/[0.08] bg-transparent text-[14px] text-nova-text-secondary not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
							>
								Edit condition
							</Button>
							<Button
								ref={clearButtonRef}
								type="button"
								variant="ghost"
								size="xl"
								onClick={() => setConfirmingClear(true)}
								className="shrink-0 px-3 text-[14px] text-nova-text-muted"
							>
								{clearLabel}
							</Button>
						</div>
					</div>
				)}
			</section>

			<AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
				<AlertDialogContent
					finalFocus={() => addButtonRef.current ?? clearButtonRef.current}
					className="text-left"
				>
					<AlertDialogHeader>
						<AlertDialogTitle>{clearTitle}</AlertDialogTitle>
						<AlertDialogDescription>{clearConsequence}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								focusAddAfterClearRef.current = true;
								onChange(undefined);
								setConfirmingClear(false);
							}}
						>
							{clearLabel}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function AdvancedSearchSettings({
	active,
	attention,
	label,
	defaultOpen,
	children,
}: {
	readonly active: boolean;
	readonly attention: boolean;
	readonly label: string;
	readonly defaultOpen: boolean;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(active || defaultOpen);
	useEffect(() => {
		if (active || attention) setOpen(true);
	}, [active, attention]);
	return (
		<section
			data-search-settings-attention={attention ? "true" : undefined}
			className="border-t border-white/[0.06] pt-1"
		>
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="xl"
							className="group w-full justify-start gap-2 px-0 text-left not-disabled:hover:bg-transparent"
						/>
					}
				>
					<Icon
						icon={tablerChevronRight}
						width="13"
						height="13"
						className="shrink-0 text-nova-text-muted transition-transform group-data-[panel-open]:rotate-90"
					/>
					<span className="text-[14px] font-medium text-nova-text-secondary transition-colors group-hover:text-nova-text">
						{label}
					</span>
					{attention ? (
						<span className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium text-nova-rose">
							Needs attention
						</span>
					) : active ? (
						<span className="ml-auto text-[12px] text-nova-violet-bright">
							In use
						</span>
					) : null}
				</CollapsibleTrigger>
				<CollapsibleContent className="space-y-5 pb-2 pt-2">
					{children}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}
