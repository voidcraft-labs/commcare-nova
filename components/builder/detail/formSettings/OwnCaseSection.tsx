// components/builder/detail/formSettings/OwnCaseSection.tsx
//
// This form's case in form settings: on a close form, **Close the case**;
// on a registration, **Create the case** and **Close the case it creates**
// (`ownCaseModel.ts` holds each row's choices and what each stores).
//
// `When a condition is true` opens the condition workbench over the row's
// slot (`form_open_condition` or `form_close_condition`), whose context is
// the one the validator checks it with (`useExpressionSlotContext`,
// `shared/editorAxes.ts`), so a static select's answer is a `choice` card by
// its label and a choice a condition reads cannot be removed out from under
// it. Choosing it stores nothing until the author completes a condition,
// which commits as one `updateForm`; Cancel returns the row to its stored
// choice. Every other choice commits its stored value as one `updateForm`.
//
// Under each row is where CommCare HQ keeps that change
// (`lib/doc/casePlacements.ts::formCasePlacementView`), with the held
// suffix where the published app already keeps it there: the create is the
// own case's place, and a close is the own close's block when it has one,
// else the own case's place. A registration that never closes its case has
// no close to place, so that row shows no line.

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
import { editorAxesOf } from "@/components/builder/shared/editorAxes";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCasePlacements } from "@/lib/doc/hooks/useCasePlacements";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import { useExpressionSlotContext } from "@/lib/doc/hooks/useExpressionSlotContext";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import { type Expression, placementLine } from "@/lib/domain";
import {
	checkExpression,
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
	nextOwnCaseLocal,
	nextOwnCaseLocalState,
	type OwnCaseChoice,
	type OwnCaseChoiceOutcome,
	type OwnCaseConditionPatch,
	type OwnCaseConditionSlot,
	type OwnCaseLocalState,
	type OwnCaseRowModel,
	ownCaseChoiceOutcome,
	ownCaseConditionCommitPatch,
	ownCaseRowModels,
	settleOwnCaseRow,
} from "./ownCaseModel";
import type { FormSettingsSectionProps } from "./types";

export function OwnCaseSection({
	moduleUuid,
	formUuid,
}: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const [local, setLocal] = useState<OwnCaseLocalState | null>(null);
	if (form === undefined) return null;
	if (form.type === "registration") {
		return (
			<div className="space-y-3">
				{ownCaseRowModels(form, local).map((row) => (
					<OwnCaseRow
						key={row.key}
						moduleUuid={moduleUuid}
						formUuid={formUuid}
						row={row}
						onChoose={(choice) => {
							const outcome = ownCaseChoiceOutcome(form, row.key, choice);
							setLocal((current) =>
								nextOwnCaseLocal(current, formUuid, row.key, outcome),
							);
							return outcome;
						}}
						commitPatch={(condition) =>
							ownCaseConditionCommitPatch(form.type, row.key, condition)
						}
						onSettled={() =>
							setLocal((current) =>
								settleOwnCaseRow(current, formUuid, row.key),
							)
						}
					/>
				))}
			</div>
		);
	}
	const model = closeRowModel(form, local);
	if (model === undefined) return null;
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
	/* A held place, one the published app keeps, says so after its line. */
	const placement = placements.ownClose ?? placements.own;
	const placementWords =
		placement === undefined
			? undefined
			: placementLine(placement.placement, placement.held);

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
			{placementWords !== undefined && (
				<p className="text-xs leading-relaxed text-nova-text-muted">
					{placementWords}
				</p>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}

/** The words a row's condition workbench calls the whole rule. */
const ROOT_LABELS: Readonly<Record<OwnCaseConditionSlot, string>> = {
	form_open_condition: "when the case is created",
	form_close_condition: "when the case closes",
};

/**
 * One of a registration's rows: its choices, the condition workbench while
 * the row reads `When a condition is true`, and where CommCare HQ keeps the
 * change beneath it.
 */
function OwnCaseRow({
	moduleUuid,
	formUuid,
	row,
	onChoose,
	commitPatch,
	onSettled,
}: FormSettingsSectionProps & {
	readonly row: OwnCaseRowModel;
	readonly onChoose: (choice: OwnCaseChoice) => OwnCaseChoiceOutcome;
	readonly commitPatch: (condition: Expression) => OwnCaseConditionPatch;
	/** The awaited condition landed or was abandoned. */
	readonly onSettled: () => void;
}) {
	const labelId = useId();
	const canEdit = useCanEdit();
	const { inline } = useBlueprintMutations();
	const [rejection, setRejection] = useState<string | null>(null);
	const placements = useCasePlacements(formUuid);
	/* The create is the own case's place; a close is its own block's when it
	 * has one, else the own case's. A case never closed has no close to
	 * place. */
	const placement =
		row.key === "create"
			? placements.own
			: row.choice === "never"
				? undefined
				: (placements.ownClose ?? placements.own);
	const placementWords =
		placement === undefined
			? undefined
			: placementLine(placement.placement, placement.held);

	const choose = (choice: OwnCaseChoice) => {
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
		<div className="space-y-2" data-own-case-row={row.key}>
			<span id={labelId} className={`${INSPECTOR_LABEL_CLS} block`}>
				{row.label}
			</span>
			<SegmentedRow
				legend={row.label}
				options={row.choices}
				value={row.choice}
				onChange={choose}
			/>
			{row.choice === "condition" && (
				<CloseConditionEditor
					moduleUuid={moduleUuid}
					formUuid={formUuid}
					slotName={row.slot}
					stored={row.condition}
					canEdit={canEdit}
					onCommit={(condition) => {
						const result = inline.updateForm(formUuid, commitPatch(condition));
						setRejection(result.ok ? null : (result.messages[0] ?? null));
						if (result.ok) onSettled();
						return result.ok;
					}}
					onAbandon={onSettled}
				/>
			)}
			{placementWords !== undefined && (
				<p className="text-xs leading-relaxed text-nova-text-muted">
					{placementWords}
				</p>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}

/**
 * An own-case condition's card editor over `slotName`, the close form's
 * close condition unless another is named. Over a stored condition every
 * edit commits; over nothing stored (`awaiting-condition`) the author edits
 * a local draft and Save condition commits it, while Cancel leaves the form
 * as it was.
 */
function CloseConditionEditor({
	moduleUuid,
	formUuid,
	slotName = "form_close_condition",
	stored,
	canEdit,
	onCommit,
	onAbandon,
}: FormSettingsSectionProps & {
	readonly slotName?: OwnCaseConditionSlot;
	readonly stored: Expression | undefined;
	readonly canEdit: boolean;
	readonly onCommit: (condition: Expression) => boolean;
	readonly onAbandon: () => void;
}) {
	const slot = {
		entity: "form",
		uuid: formUuid,
		slot: slotName,
	} as const;
	const expressionContext = useExpressionSlotContext(slot);
	const caseTypes = useEffectiveCaseTypes();
	const userProperties = useUserProperties();
	const fieldEntries = useFormFieldEntries(formUuid);
	const module = useModule(moduleUuid);
	const currentCaseType = module?.caseType ?? "";
	// The own case's create and close run once per submission, so they read
	// the answers outside every repeat, as a case change that runs once
	// does.
	const formFields = useMemo(
		() => operationFormFieldDecls(fieldEntries, undefined),
		[fieldEntries],
	);
	const [draft, setDraft] = useState<Expression | undefined>(undefined);

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
	/* What creates or closes a case is nearly always an answer, so the draft
	 * starts as
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
	// Save condition waits for a condition the checker admits.
	const draftValid =
		checkExpression(value, expressionContext).errors.length === 0;

	return (
		<div className="space-y-2 rounded-lg border border-white/[0.05] bg-white/[0.03] px-2.5 py-2">
			<fieldset disabled={!canEdit} className="contents">
				<PredicateWorkbench
					expressionContext={expressionContext}
					value={value}
					onChange={(next) => {
						if (stored !== undefined) {
							onCommit(next);
							return;
						}
						setDraft(next);
					}}
					rootLabel={ROOT_LABELS[slotName]}
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
