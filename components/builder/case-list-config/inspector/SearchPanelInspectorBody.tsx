// components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx
//
// Properties for the search panel itself: what the search canvas's
// panel chrome selects. Owns every Search-screen `caseSearchConfig` slot:
//
//   1. `searchScreenTitle`: title above the search inputs. **Show a title**
//      off writes `NO_SEARCH_SCREEN_TITLE` and hides the field; on clears
//      the slot, which shows the default title in the field again.
//   2. `searchScreenSubtitle`: markdown subtitle below the title.
//   3. `searchButtonDisplayCondition`: optional predicate gating the
//      button's visibility at runtime. This rail only summarizes it
//      (through the shared `ConditionSlotSetting`); the center Search
//      workbench is its one editing surface.
//   4. `workflow` and `formsReadSearch`: When this menu opens
//      (`SearchWorkflowSetting`), what a worker sees first and whether the
//      menu's forms read the search. Each choice is disabled with its reason
//      where a declared platform or the gate refuses it, never withheld.
// The search button's text is not authored: it reads
// `CASE_SEARCH_BUTTON_LABEL` in every language, and the rail says so.
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
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { OptionalTextRow } from "@/components/builder/inspector/OptionalTextRow";
import { ConditionSlotSetting } from "@/components/builder/shared/ConditionSlotSetting";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import { useExpressionSlotContext } from "@/lib/doc/hooks/useExpressionSlotContext";
import { useOwnerPlatformFeatures } from "@/lib/doc/hooks/usePlatformNotes";
import {
	CASE_SEARCH_BUTTON_LABEL,
	type CaseType,
	DEFAULT_CASE_SEARCH_TITLE,
	NO_SEARCH_SCREEN_TITLE,
	type OrdinaryCaseSearchConfig,
	searchScreenTitleText,
	searchWorkflow,
	type Uuid,
} from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { DISCLOSURE_ROW_CLS } from "@/lib/styles";
import { SearchWorkflowSetting } from "./SearchWorkflowSetting";
import {
	BUTTON_ONLY_SEARCH_SCREEN_LINE,
	FORMS_READ_SEARCH_NO_BUTTON_LINE,
	RESULTS_ON_OPEN_LINE,
} from "./searchWorkflowModel";

export interface SearchPanelInspectorBodyProps {
	readonly moduleUuid: Uuid | undefined;
	/** Current case-search configuration. `undefined` means the module
	 *  has no caseSearchConfig authored yet: first edit seeds the slot
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
	/** Opens the Search-action availability condition in the workbench. */
	readonly onEditDisplayCondition: (focusNewCondition?: boolean) => void;
	/** The Search-action condition is invalid and needs repair. */
	readonly searchSettingsHasError?: boolean;
}

/** What the Search screen's platform note can state. Search first's and
 *  Results first's notes sit under When this menu opens. */
const SEARCH_PANEL_NOTE_FEATURES: readonly PlatformFeatureId[] = [
	"search",
	"search-screen-text",
];

export function SearchPanelInspectorBody({
	moduleUuid,
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	hasVisibleSearchScreen = true,
	hasSearchAction,
	onEditDisplayCondition,
	searchSettingsHasError = false,
}: SearchPanelInspectorBodyProps) {
	const expressionContext = useExpressionSlotContext(
		moduleUuid === undefined
			? undefined
			: {
					entity: "module",
					uuid: moduleUuid,
					slot: "search_button_display_condition",
				},
	);
	const showsTitle = searchScreenTitleText(value) !== null;
	const setShowTitle = (next: boolean) =>
		onChange(
			setOptionalSlot(
				value,
				"searchScreenTitle",
				next ? undefined : NO_SEARCH_SCREEN_TITLE,
			),
		);
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
	const setDisplayCondition = (next: Expression | undefined) =>
		onChange(setOptionalSlot(value, "searchButtonDisplayCondition", next));
	const formsReadSearch = value?.formsReadSearch === true;
	const workflow = value === undefined ? undefined : searchWorkflow(value);
	const noteFeatures = useOwnerPlatformFeatures(
		moduleUuid === undefined ? undefined : { kind: "module", moduleUuid },
		SEARCH_PANEL_NOTE_FEATURES,
	);
	const searchActionIsActive = hasSearchAction ?? value !== undefined;
	const advancedIsActive = value?.searchButtonDisplayCondition !== undefined;

	return (
		<>
			{hasVisibleSearchScreen ? (
				<>
					<div data-search-show-title={showsTitle ? "true" : "false"}>
						<ToggleRow
							label="Show a title"
							description="A heading above the search fields in Web Apps"
							checked={showsTitle}
							onChange={setShowTitle}
						/>
					</div>

					{showsTitle && (
						<OptionalTextRow
							label="Title"
							hint="Shown above the search fields"
							// The worker sees this real default, so the author should edit
							// that same value rather than infer it from disposable
							// placeholder copy.
							value={searchScreenTitleText(value) ?? DEFAULT_CASE_SEARCH_TITLE}
							onCommit={setTitle}
						/>
					)}

					<OptionalMarkdownRow
						label="Subtitle"
						hint="Shown below the title"
						value={value?.searchScreenSubtitle}
						onCommit={setSubtitle}
					/>

					<p className="px-1 text-[13px] leading-relaxed text-nova-text-muted">
						The search button reads “{CASE_SEARCH_BUTTON_LABEL}” in every
						language.
					</p>
				</>
			) : (
				<p className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary">
					{!searchActionIsActive
						? "People can browse the case list without filling in a Search screen. Add Search from Results when they need a separate continue action."
						: workflow === "skipToResults"
							? RESULTS_ON_OPEN_LINE
							: workflow === "searchFirst"
								? BUTTON_ONLY_SEARCH_SCREEN_LINE
								: "There's nothing to fill in. Search is available from the case list, so workers can continue without entering search information."}
				</p>
			)}

			{searchActionIsActive &&
				moduleUuid !== undefined &&
				value !== undefined && (
					<SearchWorkflowSetting moduleUuid={moduleUuid} value={value} />
				)}

			<PlatformNoteRow features={noteFeatures} className="px-1" />

			<AdvancedSearchSettings
				active={advancedIsActive}
				attention={searchSettingsHasError}
				label="More settings"
				defaultOpen={false}
			>
				{formsReadSearch &&
				value?.searchButtonDisplayCondition === undefined ? (
					<p className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary">
						{FORMS_READ_SEARCH_NO_BUTTON_LINE}
					</p>
				) : (
					<ConditionSlotSetting
						expressionContext={expressionContext}
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
					/>
				)}
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
					render={<button type="button" className={DISCLOSURE_ROW_CLS} />}
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
