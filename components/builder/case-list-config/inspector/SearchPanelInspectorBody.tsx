// components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx
//
// Properties for the search panel itself — what the search canvas's
// panel chrome selects. Owns every Search-screen `caseSearchConfig` slot:
//
//   1. `searchScreenTitle` — title above the search inputs.
//   2. `searchScreenSubtitle` — markdown subtitle below the title.
//   3. `searchButtonLabel` — label on the search button.
//   4. `searchButtonDisplayCondition` — optional predicate gating the
//      button's visibility at runtime. This rail only summarizes it
//      (through the shared `ConditionSlotSetting`); the center Search
//      workbench is its one editing surface.
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
import { type ReactNode, useEffect, useState } from "react";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { OptionalTextRow } from "@/components/builder/inspector/OptionalTextRow";
import { ConditionSlotSetting } from "@/components/builder/shared/ConditionSlotSetting";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import { Button } from "@/components/shadcn/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	type CaseType,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	type OrdinaryCaseSearchConfig,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";

export interface SearchPanelInspectorBodyProps {
	/** Current case-search configuration. `undefined` means the module
	 *  has no caseSearchConfig authored yet — first edit seeds the slot
	 *  with the changed sub-slot on top of an otherwise-empty config. */
	readonly value: OrdinaryCaseSearchConfig | undefined;
	readonly onChange: (next: OrdinaryCaseSearchConfig) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	/** Search-input declarations available while authoring the condition. */
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/** False when there are no input fields, so Search-screen copy never renders. */
	readonly hasVisibleSearchScreen?: boolean;
	/** Whether a real Search action exists. Owner-only availability deliberately
	 * passes false even though it shares the same configuration object. */
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
	const searchActionIsActive = hasSearchAction ?? value !== undefined;
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
				<ConditionSlotSetting
					title="When Search is available"
					description="Offer the Search action only when a condition matches"
					value={value?.searchButtonDisplayCondition}
					onChange={setDisplayCondition}
					onEdit={onEditDisplayCondition}
					alwaysSummary="Search is always available"
					clearLabel="Always allow Search"
					clearTitle="Always allow Search?"
					clearConsequence="The current condition will be removed, and Search will be available whenever this case list can search. You can undo this change."
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					// The Search action's relevance resolves before any case is
					// selected, so the seed compares a session value.
					caseDataScope="global"
				/>
			</AdvancedSearchSettings>
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
