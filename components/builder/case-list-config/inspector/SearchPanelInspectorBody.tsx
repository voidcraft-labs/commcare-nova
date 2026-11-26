// components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx
//
// Properties for the search panel itself: what the search canvas's
// panel chrome selects. Owns every Search-screen `caseSearchConfig` slot:
//
//   1. `searchScreenTitle`: title above the search inputs. **Show a title**
//      off writes `NO_SEARCH_SCREEN_TITLE` and hides the field; on clears
//      the slot, which shows the default title in the field again. In
//      another language the switch is that language's own: off holds the
//      title blank there, and on gives it the default title's words, since
//      clearing would show the source's title, which may be none.
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
import { type ReactNode, useEffect, useId, useState } from "react";
import { SearchResultsNameSection } from "@/components/builder/detail/moduleSettings/SearchResultsNameSection";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { OptionalTextRow } from "@/components/builder/inspector/OptionalTextRow";
import { useShowsSourceLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { ConditionSlotSetting } from "@/components/builder/shared/ConditionSlotSetting";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import type { EditorSearchInputDecl } from "@/components/builder/shared/searchInputPresentation";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/shadcn/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
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
import { type Expression, matchAll } from "@/lib/domain/expression";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import { DISCLOSURE_ROW_CLS } from "@/lib/styles";
import { ProjectSearchSettings } from "./ProjectSearchSettings";
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
	readonly requestedTypes?: readonly string[];
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
	/** Where the worker can reach this search on a menu that shows its forms above. */
	readonly formsAboveSearchNote?: string;
}

/** What the Search screen's platform note can state. Search first's and
 *  Results first's notes sit under When this menu opens. */
const SEARCH_PANEL_NOTE_FEATURES: readonly PlatformFeatureId[] = [
	"search-on-clear",
	"search",
	"search-screen-text",
];

export function SearchPanelInspectorBody({
	moduleUuid,
	value,
	onChange,
	caseTypes,
	currentCaseType,
	requestedTypes = [currentCaseType],
	knownInputs = [],
	hasVisibleSearchScreen = true,
	hasSearchAction,
	onEditDisplayCondition,
	searchSettingsHasError = false,
	formsAboveSearchNote,
}: SearchPanelInspectorBodyProps) {
	const unavailableReasonId = useId();
	const expressionContext = useExpressionSlotContext(
		moduleUuid === undefined
			? undefined
			: {
					entity: "module",
					uuid: moduleUuid,
					slot: "search_button_display_condition",
				},
	);
	const showsSource = useShowsSourceLanguage();
	const showsTitle = searchScreenTitleText(value) !== null;
	/* Showing a title is the app's setting, in every language: off holds no
	 * title on the source, which every language then shows, and on clears
	 * it, so every language shows its title again, whichever language the
	 * Builder shows (`projectBuilderLanguageMutations.ts`). */
	const setShowTitle = (next: boolean) =>
		onChange(
			setOptionalSlot(
				value,
				"searchScreenTitle",
				!next ? NO_SEARCH_SCREEN_TITLE : undefined,
			),
		);
	const setTitle = (next: string | undefined) => {
		// The default title's words are the absent title in the source; in
		// another language they are that language's own text, since clearing
		// would show the source's title there.
		const authored =
			showsSource && next === DEFAULT_CASE_SEARCH_TITLE ? undefined : next;
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

	const relatedPolicies = {
		auto: "Follow the displayed information",
		details: "Only records used by details",
		hierarchy: "The whole related hierarchy",
	} as const;
	const policy = value?.relatedRecords ?? "auto";
	const property = value?.relatedRecordIdProperty;
	const properties = [
		...new Set([
			...caseTypes
				.filter((type) => requestedTypes.includes(type.name))
				.flatMap((type) => type.properties.map((p) => p.name)),
			...(property ? [property] : []),
		]),
	];
	return (
		<>
			{formsAboveSearchNote !== undefined && (
				<p
					id={unavailableReasonId}
					data-search-forms-above
					className="rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					{formsAboveSearchNote}
				</p>
			)}
			<fieldset
				aria-describedby={
					formsAboveSearchNote === undefined ? undefined : unavailableReasonId
				}
				className="m-0 min-w-0 space-y-4 border-0 p-0"
			>
				{moduleUuid && (
					<ProjectSearchSettings
						moduleUuid={moduleUuid}
						value={value}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
					/>
				)}
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
								value={
									searchScreenTitleText(value) ?? DEFAULT_CASE_SEARCH_TITLE
								}
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
					{moduleUuid !== undefined && (
						<SearchResultsNameSection moduleUuid={moduleUuid} />
					)}
					{searchActionIsActive && (
						<>
							<div className="space-y-1 text-sm">
								Related records
								<Select
									value={policy}
									onValueChange={(choice) => {
										if (
											choice === "auto" ||
											choice === "details" ||
											choice === "hierarchy"
										)
											onChange(
												setOptionalSlot(
													value,
													"relatedRecords",
													choice === "auto" ? undefined : choice,
												),
											);
									}}
								>
									<SelectTrigger aria-label="Related records">
										<SelectValue>{relatedPolicies[policy]}</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{Object.entries(relatedPolicies).map(([key, label]) => (
											<SelectItem key={key} value={key}>
												{label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{properties.length > 0 && (
								<div className="space-y-1 text-sm">
									Record ID to follow
									<Select
										value={property ?? "#none"}
										onValueChange={(choice) => {
											if (choice)
												onChange(
													setOptionalSlot(
														value,
														"relatedRecordIdProperty",
														choice === "#none" ? undefined : choice,
													),
												);
										}}
									>
										<SelectTrigger aria-label="Record ID to follow">
											<SelectValue>
												{property ?? "No additional record"}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="#none">
												No additional record
											</SelectItem>
											{properties.map((key) => (
												<SelectItem key={key} value={key}>
													{key}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</>
					)}
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
							// selected, in the scope of each entry that shows the list,
							// which loads the session only where its selection or its
							// forms' returns read it (`CASE_SEARCH_BUTTON_DISPLAY_CONDITION_NOT_ON_THE_LIST`).
							// So Add seeds "always", which every list can evaluate, and
							// the author builds the rule from there.
							seed={matchAll}
						/>
					)}
				</AdvancedSearchSettings>
			</fieldset>
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
