// components/builder/shared/ConditionSlotSetting.tsx
//
// The settings-panel half of every condition slot whose editor lives in
// the centre canvas: one plain-language summary plus Add / Edit / Clear.
//
// The pairing is the point. A recursive condition tree needs the full
// canvas width, so the panel that OWNS the setting never duplicates the
// editor: it names the setting, says what it currently does, and hands
// off. `data-condition-origin` marks the Edit control so a canvas that
// returns IN PLACE (the case workspace, whose rail stays mounted) can
// hand focus back to the exact row the author left from.
//
// Adding is one gesture, not two: it commits a valid seed AND opens the
// editor, so an author never lands on an empty screen wondering what to
// do. Clearing is confirmed through the shared `ClearConditionButton`,
// which the centre-canvas editors use too: the same words wherever the
// removal is offered.

"use client";

import { summarizeFilter } from "@/components/builder/case-list-config/predicateSummary";
import { Button } from "@/components/shadcn/button";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { CaseType } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { useClearedSlotFocus } from "@/lib/ui/hooks/useClearedSlotFocus";
import { ClearConditionButton } from "./ClearConditionButton";
import { firstComparisonDefault } from "./cards/comparisonSeed";
import type { CaseDataScope } from "./editorSchemas";
import type { EditorSearchInputDecl } from "./searchInputPresentation";

export interface ConditionSlotSettingProps {
	/** Omitted when the surrounding panel already titles the setting. */
	readonly title?: string;
	readonly description: string;
	readonly value: Predicate | undefined;
	/** `undefined` removes the condition. */
	readonly onChange: (next: Predicate | undefined) => void;
	/**
	 * Open the centre-canvas editor. `true` says this row just created
	 * the condition, so the editor can land the author on it. What that
	 * means is the editor's call: the Search workbench focuses the new
	 * condition, while a display-condition screen focuses its own heading
	 * because that screen leads with an explanation the author needs
	 * before the rule itself.
	 */
	readonly onEdit: (focusNewCondition?: boolean) => void;
	/** What "no condition" means here, in the author's own terms. */
	readonly alwaysSummary: string;
	readonly addLabel?: string;
	readonly editLabel?: string;
	readonly clearLabel: string;
	readonly clearTitle: string;
	readonly clearConsequence: string;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	readonly knownInputs?: readonly EditorSearchInputDecl[];
	/** The slot's evaluation scope: decides what the seed may read. */
	readonly caseDataScope: CaseDataScope;
	/** A viewer reads the rule; Add and Clear are not offered. Editing
	 *  stays available so the condition can still be opened and read. */
	readonly canEdit?: boolean;
}

export function ConditionSlotSetting({
	title,
	description,
	value,
	onChange,
	onEdit,
	alwaysSummary,
	addLabel = "Add condition",
	editLabel = "Edit condition",
	clearLabel,
	clearTitle,
	clearConsequence,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	caseDataScope,
	canEdit = true,
}: ConditionSlotSettingProps) {
	/* The Clear control unmounts with the condition it removed, so the intent
	 * to move focus has to outlive it. `useClearedSlotFocus` is that rule's one
	 * home: it started here, and the case-change canvas needs the same thing
	 * in three more places. */
	const { addRef: addButtonRef, onCleared } = useClearedSlotFocus(value);
	const projectProse = useProseProjection();

	const add = () => {
		onChange(
			firstComparisonDefault({
				caseTypes,
				currentCaseType,
				knownInputs,
				caseDataScope,
			}),
		);
		onEdit(true);
	};
	return (
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
					variant="ghost"
					disabled={!canEdit}
					onClick={add}
					className="nova-add-slot w-full"
				>
					{addLabel}
				</Button>
			) : (
				<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3">
					<p className="text-[13px] leading-relaxed text-nova-text-secondary">
						{summarizeFilter(value, {
							caseTypes,
							currentCaseType,
							knownInputs,
							projectProse,
						}) ?? alwaysSummary}
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						<Button
							data-condition-origin
							type="button"
							variant="outline"
							onClick={() => onEdit()}
							className="min-w-0 flex-1"
						>
							{canEdit ? editLabel : "View condition"}
						</Button>
						{canEdit && (
							<ClearConditionButton
								label={clearLabel}
								title={clearTitle}
								consequence={clearConsequence}
								finalFocus={() => addButtonRef.current}
								onConfirm={() => {
									onCleared();
									onChange(undefined);
								}}
							/>
						)}
					</div>
				</div>
			)}
		</section>
	);
}
