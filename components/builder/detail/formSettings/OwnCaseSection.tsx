// components/builder/detail/formSettings/OwnCaseSection.tsx
//
// This form's case in form settings: on a close form, **Close the case**.
//
// `Every time` stores no condition; `When a condition is true` opens the
// ordinary card editor over the `form_close_condition` slot, whose context
// is the one the validator checks it with (`useExpressionSlotContext`,
// `shared/editorAxes.ts`), so a static select's answer is a `choice` card by
// its label and a choice a condition reads cannot be removed out from under
// it. Choosing it stores nothing until the author completes a condition,
// which commits as one `updateForm` (`ownCaseModel.ts`).
//
// Under it is where CommCare HQ keeps the close: the own close's block
// when it has one, else the own case's place
// (`lib/doc/casePlacements.ts::formCasePlacementView`).

"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { operationFormFieldDecls } from "@/components/builder/case-operations/formFieldScope";
import {
	INSPECTOR_LABEL_CLS,
	SegmentedRow,
} from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { reseedLiteralForConstraint } from "@/components/builder/shared/cards/reseed";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { editorAxesOf } from "@/components/builder/shared/editorAxes";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCasePlacements } from "@/lib/doc/hooks/useCasePlacements";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useExpressionSlotContext } from "@/lib/doc/hooks/useExpressionSlotContext";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import type { Expression } from "@/lib/domain";
import {
	compatibleTypesFor,
	eq,
	formField,
	literal,
} from "@/lib/domain/expression";
import { useCanEdit } from "@/lib/session/hooks";
import {
	CLOSE_CHOICES,
	closeChoiceOutcome,
	closeConditionCommitPatch,
	closeRowModel,
	nextOwnCaseLocalState,
	type OwnCaseLocalState,
} from "./ownCaseModel";
import type { FormSettingsSectionProps } from "./types";

export function OwnCaseSection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const [local, setLocal] = useState<OwnCaseLocalState | null>(null);
	const model = form === undefined ? undefined : closeRowModel(form, local);
	if (form === undefined || model === undefined) return null;
	return (
		<CloseCaseRow
			moduleUuid={moduleUuid}
			formUuid={formUuid}
			model={model}
			onChoose={(choice) => {
				const outcome = closeChoiceOutcome(form, choice);
				setLocal(nextOwnCaseLocalState(formUuid, outcome));
				return outcome;
			}}
			onSettled={() => setLocal(null)}
		/>
	);
}

function CloseCaseRow({
	moduleUuid,
	formUuid,
	model,
	onChoose,
	onSettled,
}: FormSettingsSectionProps & {
	readonly model: NonNullable<ReturnType<typeof closeRowModel>>;
	readonly onChoose: (
		choice: (typeof CLOSE_CHOICES)[number]["value"],
	) => ReturnType<typeof closeChoiceOutcome>;
	/** The awaited condition landed or was abandoned. */
	readonly onSettled: () => void;
}) {
	const labelId = useId();
	const canEdit = useCanEdit();
	const { inline } = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const placements = useCasePlacements(formUuid);
	const placementLine = (placements.ownClose ?? placements.own)?.line;

	const choose = (choice: (typeof CLOSE_CHOICES)[number]["value"]) => {
		if (!canEdit) return;
		const outcome = onChoose(choice);
		if (outcome.kind !== "commit") {
			setRejection(null);
			return;
		}
		const result = inline.updateForm(formUuid, outcome.patch);
		setRejection(result.ok ? null : (result.messages[0] ?? null));
	};

	return (
		<div className="space-y-2" data-own-case-close>
			<span id={labelId} className={`${INSPECTOR_LABEL_CLS} block`}>
				Close the case
			</span>
			<SegmentedRow
				legend="Close the case"
				options={CLOSE_CHOICES}
				value={model.choice}
				onChange={choose}
			/>
			{model.choice === "condition" && (
				<CloseConditionEditor
					moduleUuid={moduleUuid}
					formUuid={formUuid}
					stored={model.condition}
					canEdit={canEdit}
					onCommit={(condition) => {
						const result = inline.updateForm(
							formUuid,
							closeConditionCommitPatch(condition),
						);
						setRejection(result.ok ? null : (result.messages[0] ?? null));
						if (result.ok) onSettled();
						return result.ok;
					}}
					onAbandon={onSettled}
				/>
			)}
			{placementLine !== undefined && (
				<p className="text-xs leading-relaxed text-nova-text-muted">
					{placementLine}
				</p>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}

/**
 * The close condition's card editor. Over a stored condition every edit
 * commits; over nothing stored (`awaiting-condition`) the author edits a
 * local draft and Save condition commits it, while Cancel leaves the form
 * as it was.
 */
function CloseConditionEditor({
	moduleUuid,
	formUuid,
	stored,
	canEdit,
	onCommit,
	onAbandon,
}: FormSettingsSectionProps & {
	readonly stored: Expression | undefined;
	readonly canEdit: boolean;
	readonly onCommit: (condition: Expression) => boolean;
	readonly onAbandon: () => void;
}) {
	const slot = {
		entity: "form",
		uuid: formUuid,
		slot: "form_close_condition",
	} as const;
	const expressionContext = useExpressionSlotContext(slot);
	const caseTypes = useEffectiveCaseTypes();
	const userProperties = useUserProperties();
	const fieldEntries = useFormFieldEntries(formUuid);
	const module = useModule(moduleUuid);
	const currentCaseType = module?.caseType ?? "";
	// The close runs once per submission, so it reads the answers outside
	// every repeat, as a case change that runs once does.
	const formFields = useMemo(
		() => operationFormFieldDecls(fieldEntries, undefined),
		[fieldEntries],
	);
	const [draft, setDraft] = useState<Expression | undefined>(undefined);
	const [draftValid, setDraftValid] = useState(true);

	/* The draft belongs to the awaited condition of this form: a stored
	 * condition (this commit, or a peer's) supersedes it. */
	useEffect(() => {
		if (stored !== undefined) setDraft(undefined);
	}, [stored]);

	if (expressionContext === undefined) {
		return (
			<p role="status" className="text-xs text-nova-text-muted">
				This form is no longer available.
			</p>
		);
	}
	/* What closes a case is nearly always an answer, so the draft starts as
	 * the form's first single answer compared with a value to fill in. A
	 * form with no such answer starts from the editor's own first
	 * condition. */
	const answer = formFields.find(
		(field) =>
			field.dataType !== "multi_select" && field.dataType !== "geopoint",
	);
	const seed =
		draft ??
		(answer === undefined
			? firstComparisonDefault({
					expressionContext,
					caseTypes,
					currentCaseType,
					knownInputs: [],
					userProperties,
					formFields,
					...editorAxesOf(expressionContext),
				})
			: eq(
					formField(answer.uuid),
					reseedLiteralForConstraint(
						literal(""),
						compatibleTypesFor(answer.dataType),
					),
				));
	const value = stored ?? seed;

	return (
		<div className="space-y-2 rounded-lg border border-white/[0.05] bg-white/[0.03] px-2.5 py-2">
			<fieldset disabled={!canEdit} className="contents">
				<ExpressionCardEditor
					expressionContext={expressionContext}
					value={value}
					onChange={(next) => {
						if (stored !== undefined) {
							onCommit(next);
							return;
						}
						setDraft(next);
					}}
					onValidityChange={setDraftValid}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					userProperties={userProperties}
					formFields={formFields}
				/>
			</fieldset>
			{stored === undefined && canEdit && (
				<div className="flex flex-wrap justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							setDraft(undefined);
							onAbandon();
						}}
					>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!draftValid}
						onClick={() => {
							if (onCommit(value)) setDraft(undefined);
						}}
					>
						Save condition
					</Button>
				</div>
			)}
		</div>
	);
}
