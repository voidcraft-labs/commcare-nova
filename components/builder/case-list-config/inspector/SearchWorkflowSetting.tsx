// components/builder/case-list-config/inspector/SearchWorkflowSetting.tsx
//
// When this menu opens: the Search panel's choice of what a worker sees
// first (`caseSearchConfig.workflow`), and, under Search first and Results
// first, whether the menu's forms read the search (`formsReadSearch`). Every
// choice is offered by where the app runs and by the gate, disabled with the
// reason rather than withheld; a stored choice shows as it is. The patches,
// the reasons and the words live in the pure `searchWorkflowModel.ts`.

"use client";

import { useCallback, useId } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import { PlatformNoteRow } from "@/components/builder/shared/PlatformNoteRow";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import { useOfferedBatchRefusals } from "@/lib/doc/hooks/useOfferedBatchRefusals";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type OrdinaryCaseSearchConfig,
	type SearchWorkflow,
	searchWorkflow,
	type Uuid,
} from "@/lib/domain";
import { platformRefusal } from "@/lib/domain/platforms";
import { useCanEdit } from "@/lib/session/hooks";
import { selectableSegmentCls } from "@/lib/styles";
import { cn } from "@/lib/utils";
import {
	FORMS_READ_SEARCH_LABEL,
	FORMS_READ_SEARCH_LINE,
	formsReadSearchMutations,
	formsReadSearchOffered,
	formsReadSearchRefusal,
	SEARCH_WORKFLOW_CHOICES,
	SEARCH_WORKFLOW_LEGEND,
	searchWorkflowChoiceRefusal,
	searchWorkflowMutations,
	searchWorkflowNoteFeature,
} from "./searchWorkflowModel";

type OfferKey = SearchWorkflow | "formsReadSearch";

export function SearchWorkflowSetting({
	moduleUuid,
	value,
}: {
	readonly moduleUuid: Uuid;
	/** The module's effective ordinary search; this setting shows only
	 *  while the Search action exists. */
	readonly value: OrdinaryCaseSearchConfig;
}) {
	const canEdit = useCanEdit();
	const platforms = useDeclaredPlatforms();
	const docApi = useBlueprintDocApi();
	const { commitMany } = useBlueprintMutations();
	const groupName = useId();
	const legendId = useId();
	const current = searchWorkflow(value);
	const formsOn = value.formsReadSearch === true;

	/* Each choice the declaration offers, and the switch, asks the gate
	 * about its exact batch; a choice a platform can't run already has its
	 * reason and costs the gate nothing. */
	const plan = useCallback(
		(doc: BlueprintDoc) => {
			const batches: Partial<Record<OfferKey, readonly Mutation[]>> = {};
			for (const choice of SEARCH_WORKFLOW_CHOICES) {
				if (choice.workflow === current) continue;
				if (platformRefusal(choice.feature, platforms) !== undefined) continue;
				batches[choice.workflow] = searchWorkflowMutations(
					moduleUuid,
					choice.workflow,
				);
			}
			if (
				formsReadSearchOffered(current) &&
				(formsOn ||
					platformRefusal("forms-read-search", platforms) === undefined)
			)
				batches.formsReadSearch = formsReadSearchMutations(
					doc,
					moduleUuid,
					!formsOn,
				);
			return batches;
		},
		[current, formsOn, moduleUuid, platforms],
	);
	const gate = useOfferedBatchRefusals<OfferKey>(plan, canEdit);

	const choose = (workflow: SearchWorkflow) => {
		if (workflow === current) return;
		commitMany(searchWorkflowMutations(moduleUuid, workflow));
	};
	const setFormsReadSearch = (on: boolean) => {
		if (on === formsOn) return;
		const mutations = formsReadSearchMutations(
			docApi.getState(),
			moduleUuid,
			on,
		);
		if (mutations.length > 0) commitMany(mutations);
	};
	const noteFeature = searchWorkflowNoteFeature(current);
	const switchRefusal = formsReadSearchRefusal(
		formsOn,
		platforms,
		gate.formsReadSearch,
	);

	return (
		<div className="space-y-2" data-search-workflow-setting={current}>
			<fieldset aria-labelledby={legendId} className="min-w-0">
				<legend
					id={legendId}
					className="mb-1.5 block px-1 text-[13px] font-medium text-nova-text-secondary"
				>
					{SEARCH_WORKFLOW_LEGEND}
				</legend>
				<div className="grid gap-1 rounded-2xl bg-nova-deep/50 p-1">
					{SEARCH_WORKFLOW_CHOICES.map((choice) => {
						const selected = choice.workflow === current;
						const refusal = searchWorkflowChoiceRefusal(
							choice,
							current,
							platforms,
							gate[choice.workflow],
						);
						const disabled = !canEdit || refusal !== undefined;
						return (
							<label
								key={choice.workflow}
								data-search-workflow-choice={choice.workflow}
								className={cn(
									selectableSegmentCls(selected),
									"h-auto flex-col items-start justify-start gap-0.5 py-2 text-left whitespace-normal has-[input:focus-visible]:border-nova-ring has-[input:focus-visible]:shadow-(--focus-ring)",
									disabled && "cursor-not-allowed opacity-(--disabled-opacity)",
								)}
							>
								<input
									type="radio"
									name={groupName}
									value={choice.workflow}
									checked={selected}
									disabled={disabled}
									onChange={() => choose(choice.workflow)}
									className="sr-only"
								/>
								<span className="text-[14px] font-medium">{choice.label}</span>
								<span className="text-[13px] leading-snug text-nova-text-muted">
									{choice.line}
								</span>
								{refusal !== undefined && (
									<span className="text-[13px] leading-snug text-nova-text-muted">
										{refusal}
									</span>
								)}
							</label>
						);
					})}
				</div>
			</fieldset>

			{noteFeature !== undefined && (
				<PlatformNoteRow features={[noteFeature]} className="px-1" />
			)}

			{formsReadSearchOffered(current) && (
				<div data-forms-read-search={formsOn ? "true" : "false"}>
					<ToggleRow
						label={FORMS_READ_SEARCH_LABEL}
						description={FORMS_READ_SEARCH_LINE}
						checked={formsOn}
						onChange={setFormsReadSearch}
						disabledReason={switchRefusal}
					/>
				</div>
			)}
		</div>
	);
}
