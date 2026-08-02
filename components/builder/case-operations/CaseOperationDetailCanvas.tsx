// components/builder/case-operations/CaseOperationDetailCanvas.tsx
//
// One case change, opened.
//
// The division with the rail is a rule, not a layout accident: if it is
// a recursive AST, it is here in the centre canvas where it has width; if
// it is a discrete choice, it is in the rail. That is the same split the
// case-list workspace keeps (the rail holds a field's source and format,
// the canvas holds "Cases available"), and the display-condition screens
// before it.
//
// Every expression slot here mounts with the operation's own scope: the
// form answers this change may read (narrowed by its multiplicity, see
// `formFieldScope.ts`), the app's worker information, the submission's own
// vocabulary (the acting user, no owner, an earlier create's case), and
// what the slot may read against a case row. Together they are what let
// the shared editor offer a form answer at all, and what stop it
// offering a case read this module can never make, or an earlier create's
// id inside a runtime target. `editorScope.ts` owns the last two, because
// the target slots deliberately do NOT get the same scope as the rest.

"use client";

import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerArrowLeft from "@iconify-icons/tabler/arrow-left";
import tablerChevronLeft from "@iconify-icons/tabler/chevron-left";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerTrash from "@iconify-icons/tabler/trash";
import { useEffect, useMemo, useRef, useState } from "react";
import { ContentFrame } from "@/components/builder/ContentFrame";
import { ClearConditionButton } from "@/components/builder/shared/ClearConditionButton";
import { firstComparisonDefault } from "@/components/builder/shared/cards/comparisonSeed";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import type { CaseDataScope } from "@/components/builder/shared/editorSchemas";
import type { OperationValueScope } from "@/components/builder/shared/expressionEditorSchemas";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import {
	caseOperationTargetTypeAfter,
	retargetCaseOperation,
} from "@/lib/doc/caseOperationIntents";
import {
	useModuleCaseType,
	useModuleSelectsCaseFirst,
} from "@/lib/doc/hooks/useCaseOperationFacts";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import { useUserProperties } from "@/lib/doc/hooks/useUserCollections";
import type { Uuid } from "@/lib/doc/types";
import type {
	CaseOperation,
	CaseOperationWrite,
	CasePropertyDataType,
} from "@/lib/domain";
import {
	actingUser,
	type Predicate,
	storageAssignmentConstraint,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { useClearedSlotFocus } from "@/lib/ui/hooks/useClearedSlotFocus";
import { useRemovedRowFocus } from "@/lib/ui/hooks/useRemovedRowFocus";
import { CaseOperationLinks } from "./CaseOperationLinks";
import { useCaseTargetDraft } from "./CaseTargetDraftContext";
import {
	caseOperationRuntimeTargetConstraint,
	caseOperationTextConstraint,
	operationCaseDataScope,
	RUNTIME_TARGET_OPERATION_SCOPE,
} from "./editorScope";
import { operationFormFieldDecls } from "./formFieldScope";
import {
	casePropertyLabel,
	caseTypePhrase,
	operationSentence,
} from "./operationSentence";
import { seedCaseOperationWrite, seedRenameValue } from "./seeds";
import { useOperationSentenceContext } from "./useOperationSentenceContext";
import { WritePropertyPicker } from "./WritePropertyPicker";

export function CaseOperationDetailCanvas({
	moduleUuid,
	formUuid,
	operationUuid,
}: {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
}) {
	const view = useCaseOperations(formUuid);
	const sentenceContext = useOperationSentenceContext(formUuid);
	const navigate = useNavigate();
	const canEdit = useCanEdit();
	const caseTypes = useEffectiveCaseTypes();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const targetDraft = useCaseTargetDraft(formUuid, operationUuid);

	const operations = view.operations;
	const index = operations.findIndex(
		(candidate) => candidate.uuid === operationUuid,
	);
	const operation = index < 0 ? undefined : operations[index];

	const fieldEntries = useFormFieldEntries(formUuid);
	const userProperties = useUserProperties();
	const caseFirst = useModuleSelectsCaseFirst(moduleUuid);
	/* Clearing the condition unmounts the control that cleared it, so focus
	 * has to be handed forward to the Add button that replaces the editor. */
	const conditionCleared = useClearedSlotFocus(operation?.condition);
	/* Same shape for a removed row: the button pressed goes away with it. */
	const writeFocus = useRemovedRowFocus((operation?.writes ?? []).length);
	/* Whether a slot here may read the case at all. The gate refuses every
	 * case-data read in a form the module opens without choosing a case
	 * first: see `editorScope.ts` for why that maps onto `"global"`. */
	const caseDataScope = operationCaseDataScope(caseFirst);
	/* The scope an operation EXPRESSION resolves against is the module's case
	 * type: what `rules/caseOperations.ts::expressionContext` hands the
	 * checker, not the operation's destination type. The destination decides
	 * which PROPERTY a write may target; it never decides what the value may
	 * read. A module with no case type has no walkable origin, and the empty
	 * string is how the editor says so. */
	const expressionCaseType = useModuleCaseType(moduleUuid) ?? "";
	/* A link may point at "the case this form opened" only where the module
	 * actually hands its forms one: the same rule the validator applies to
	 * a session target. */
	const sessionUnavailableReason = caseFirst
		? undefined
		: "This module doesn't choose a case before opening its forms, so there is no case in hand";
	const formFields = useMemo(
		() => operationFormFieldDecls(fieldEntries, operation?.forEach?.repeat),
		[fieldEntries, operation?.forEach?.repeat],
	);

	/* Only the creates BEFORE this one are in scope: the same set the
	 * checker admits, so an `id-of` value can never name a case that does
	 * not exist yet at this point in the sequence. */
	const operationScope = useMemo<OperationValueScope>(() => {
		const creates: { uuid: Uuid; label: string }[] = [];
		for (const candidate of operations) {
			if (candidate.uuid === operationUuid) break;
			if (candidate.action === "create") {
				creates.push({ uuid: candidate.uuid, label: candidate.id });
			}
		}
		return { creates };
	}, [operations, operationUuid]);

	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	const backToList = () => navigate.openFormOperations(moduleUuid, formUuid);

	if (operation === undefined) {
		/* The recovery effect scrubs a stale uuid on the next tick; until it
		 * does, say what happened rather than rendering a blank. */
		return (
			<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
				<p className="text-[14px] leading-relaxed text-nova-text-muted">
					That change is no longer part of this form.
				</p>
			</ContentFrame>
		);
	}

	const destination = operation.retype ?? operation.caseType;
	const destinationType = caseTypes.find(
		(caseType) => caseType.name === destination,
	);
	const sentence = operationSentence(operation, sentenceContext);

	const operationCanEdit = canEdit;
	const commit = (next: CaseOperation): boolean => {
		if (!operationCanEdit) return false;
		const outcome = view.update(next);
		setRefusal(outcome.ok ? undefined : outcome.messages.join(" "));
		return outcome.ok;
	};
	const runtimeTargetExpression =
		operation.target.kind === "expression"
			? operation.target.expr
			: targetDraft.expression;

	const editorScope = {
		caseTypes,
		currentCaseType: expressionCaseType,
		userProperties,
		formFields,
		operationScope,
		caseDataScope,
	} as const;

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<div className="mb-5 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					onClick={backToList}
					className="-ml-2"
				>
					<Icon icon={tablerArrowLeft} width="16" height="16" />
					All case changes
				</Button>
				<span className="text-[13px] text-nova-text-muted">
					{index + 1} of {operations.length}
				</span>
				<span className="ml-auto flex gap-1">
					<Button
						type="button"
						variant="ghost"
						disabled={index === 0}
						aria-label="Previous change"
						onClick={() => {
							const previous = operations[index - 1];
							if (previous !== undefined) {
								navigate.openFormOperations(
									moduleUuid,
									formUuid,
									previous.uuid,
								);
							}
						}}
					>
						<Icon icon={tablerChevronLeft} width="16" height="16" />
						Previous
					</Button>
					<Button
						type="button"
						variant="ghost"
						disabled={index === operations.length - 1}
						aria-label="Next change"
						onClick={() => {
							const next = operations[index + 1];
							if (next !== undefined) {
								navigate.openFormOperations(moduleUuid, formUuid, next.uuid);
							}
						}}
					>
						Next
						<Icon icon={tablerChevronRight} width="16" height="16" />
					</Button>
				</span>
			</div>

			<header className="mb-7">
				<p className="text-[13px] font-medium text-nova-text-muted">
					{operation.id}
				</p>
				<h1
					ref={headingRef}
					tabIndex={-1}
					className="mt-1 font-display text-2xl font-semibold tracking-tighter text-nova-text outline-none"
				>
					{sentence.lead}
				</h1>
				<p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-nova-text-muted">
					Everything this change works out when the form is submitted. What kind
					of change it is, and which case it acts on, are in the panel beside
					this screen.
				</p>
			</header>

			{refusal !== undefined && (
				<div
					role="alert"
					className="mb-4 flex gap-2 rounded-xl border border-nova-rose/25 bg-nova-rose/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-nova-text-secondary"
				>
					<Icon
						icon={tablerAlertCircle}
						width="16"
						height="16"
						className="mt-0.5 shrink-0 text-nova-rose"
					/>
					<span>{refusal}</span>
				</div>
			)}

			<fieldset disabled={!operationCanEdit} className="contents">
				<Section
					title="When this runs"
					description={
						operation.condition === undefined
							? "Every time this form is submitted."
							: "Only when this is true of the submitted answers."
					}
					action={
						operation.condition !== undefined && operationCanEdit ? (
							<ClearConditionButton
								label="Always run"
								title="Always run this change?"
								consequence="It will happen on every submission of this form."
								finalFocus={() => conditionCleared.addRef.current}
								onConfirm={() => {
									conditionCleared.onCleared();
									commit({ ...operation, condition: undefined });
								}}
							/>
						) : undefined
					}
				>
					{operation.condition === undefined ? (
						<AddSlotButton
							ref={conditionCleared.addRef}
							label="Add a condition"
							disabled={!operationCanEdit}
							onClick={() =>
								commit({
									...operation,
									condition: firstComparisonDefault({
										caseTypes,
										currentCaseType: expressionCaseType,
										knownInputs: [],
										userProperties,
										formFields,
										operationScope,
										caseDataScope,
									}),
								})
							}
						/>
					) : (
						<PredicateWorkbench
							value={operation.condition}
							onChange={(condition: Predicate) =>
								commit({ ...operation, condition })
							}
							rootLabel="when this runs"
							caseTypes={caseTypes}
							currentCaseType={expressionCaseType}
							userProperties={userProperties}
							formFields={formFields}
							operationScope={operationScope}
							caseDataScope={caseDataScope}
						/>
					)}
				</Section>

				{runtimeTargetExpression !== undefined && (
					<Section
						title="Which case to change"
						description="Work out the case this change acts on. The result must be a case id."
						action={
							operation.target.kind !== "expression" && operationCanEdit ? (
								<Button
									type="button"
									variant="ghost"
									onClick={targetDraft.clear}
								>
									Cancel
								</Button>
							) : undefined
						}
					>
						<ExpressionCardEditor
							value={runtimeTargetExpression}
							onChange={(expr: ValueExpression) => {
								if (operation.target.kind === "expression") {
									commit({
										...operation,
										target: { kind: "expression", expr },
									});
									return;
								}
								targetDraft.update(expr);
								const next = retargetCaseOperation(
									operation,
									{ kind: "expression", expr },
									operations.slice(0, index),
									caseFirst ? expressionCaseType : undefined,
								);
								if (commit(next)) targetDraft.clear();
							}}
							constraint={caseOperationRuntimeTargetConstraint()}
							{...editorScope}
							// A runtime target may not name a create's output: target
							// that create directly instead. Owner sentinels are withheld
							// because this is not an owner-value slot.
							operationScope={RUNTIME_TARGET_OPERATION_SCOPE}
						/>
					</Section>
				)}

				{operation.action === "create" && operation.name !== undefined && (
					<Section
						title="The case's name"
						description="What people will see this case called in lists."
					>
						<ExpressionCardEditor
							value={operation.name}
							onChange={(name: ValueExpression) =>
								commit({ ...operation, name })
							}
							constraint={caseOperationTextConstraint()}
							{...editorScope}
						/>
					</Section>
				)}

				{operation.action === "update" && (
					<OptionalExpressionSection
						title="Give the case a new name"
						description="Changes what people see this case called."
						addLabel="Set a new name"
						clearLabel="Leave the name alone"
						clearTitle="Leave the name alone?"
						clearConsequence="This change will stop renaming the case."
						value={operation.rename}
						canEdit={operationCanEdit}
						seed={() => seedRenameValue(destination, formFields)}
						onChange={(rename) => commit({ ...operation, rename })}
						constraint={caseOperationTextConstraint()}
						editorScope={editorScope}
					/>
				)}

				{operation.action !== "close" && (
					<OptionalExpressionSection
						title="Who owns the case"
						description="Ownership decides whose device the case reaches. Without this, a new case belongs to the person who submitted the form."
						addLabel="Choose an owner"
						clearLabel="Use the default owner"
						clearTitle="Use the default owner?"
						clearConsequence="The case will belong to whoever submits the form."
						value={operation.owner}
						canEdit={operationCanEdit}
						seed={() => actingUser()}
						onChange={(owner) => commit({ ...operation, owner })}
						constraint={caseOperationTextConstraint()}
						editorScope={editorScope}
						ownerValues
					/>
				)}

				<Section
					title="What it saves"
					description={
						destinationType === undefined
							? `Values saved onto the ${caseTypePhrase(destination)} case.`
							: `Values saved onto the ${caseTypePhrase(destination)} case. They stay on the case after the form is submitted.`
					}
				>
					<div className="space-y-3">
						{(operation.writes ?? []).length === 0 && !operationCanEdit && (
							<p className="text-[13px] leading-relaxed text-nova-text-muted">
								This change saves no values.
							</p>
						)}
						{(operation.writes ?? []).map((write, writeIndex) => (
							<WriteRow
								key={write.property}
								write={write}
								canEdit={operationCanEdit}
								editorScope={editorScope}
								removeRef={writeFocus.register(writeIndex)}
								destinationType={view.writeValueType(
									operation.uuid,
									destination,
									write.property,
								)}
								onChange={(next) =>
									commit({
										...operation,
										writes: (operation.writes ?? []).map((candidate, i) =>
											i === writeIndex ? next : candidate,
										),
									})
								}
								onRemove={() => {
									writeFocus.onRemoved(writeIndex);
									commit({
										...operation,
										writes: (operation.writes ?? []).filter(
											(_, i) => i !== writeIndex,
										),
									});
								}}
							/>
						))}
						{operationCanEdit && (
							<WritePropertyPicker
								triggerRef={writeFocus.addRef}
								caseTypeName={destination}
								alreadyWritten={
									new Set(
										(operation.writes ?? []).map((write) => write.property),
									)
								}
								formFields={formFields}
								onChoose={(property, value) =>
									commit({
										...operation,
										writes: [
											...(operation.writes ?? []),
											seedCaseOperationWrite(property, value),
										],
									})
								}
							/>
						)}
					</div>
				</Section>

				{operation.action !== "close" && (
					<Section
						title="Connections to other cases"
						description="How this case relates to another one. A connection can also be broken here, that is what an author reaches for when a temporary grouping has served its purpose."
					>
						<CaseOperationLinks
							operation={operation}
							canEdit={operationCanEdit}
							defaultTargetType={
								(caseOperationTargetTypeAfter(
									operations.slice(0, index),
									{ kind: "session" },
									expressionCaseType || undefined,
								) ??
									expressionCaseType) ||
								operation.caseType
							}
							precedingOperations={operations.slice(0, index)}
							initialSessionCaseType={expressionCaseType || undefined}
							// The only editor a link mounts is a runtime target, so
							// `operationScope` is withheld here rather than overridden
							// there: the rows fix it to the target scope themselves.
							editorScope={{
								caseTypes,
								currentCaseType: expressionCaseType,
								userProperties,
								formFields,
								caseDataScope,
							}}
							targetContext={{
								priorCreates: operationScope.creates,
								sessionUnavailableReason,
								// A case cannot connect to itself, so the change's own
								// target is withheld with that reason.
								excludes: operation.target,
							}}
							editVerdict={(links) => view.editVerdict({ ...operation, links })}
							onChange={(links) => commit({ ...operation, links })}
						/>
					</Section>
				)}
			</fieldset>
		</ContentFrame>
	);
}

function Section({
	title,
	description,
	action,
	children,
}: {
	readonly title: string;
	readonly description: string;
	readonly action?: React.ReactNode;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="mb-6 rounded-2xl border border-white/[0.08] bg-nova-surface/25 p-4 @sm:p-5">
			<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="font-display tracking-tighter text-[17px] font-semibold text-nova-text">
						{title}
					</h2>
					<p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-nova-text-muted">
						{description}
					</p>
				</div>
				{action}
			</div>
			{children}
		</section>
	);
}

function AddSlotButton({
	label,
	disabled,
	onClick,
	ref,
}: {
	readonly label: string;
	readonly disabled: boolean;
	readonly onClick: () => void;
	/** So a clear can hand focus to the control that replaced its editor. */
	readonly ref?: React.Ref<HTMLButtonElement>;
}) {
	return (
		<Button
			ref={ref}
			type="button"
			variant="ghost"
			disabled={disabled}
			onClick={onClick}
			className="nova-add-slot w-full"
		>
			<Icon icon={tablerPlus} width="14" height="14" />
			{label}
		</Button>
	);
}

interface EditorScope {
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly currentCaseType: string;
	readonly userProperties: ReturnType<typeof useUserProperties>;
	readonly formFields: ReturnType<typeof operationFormFieldDecls>;
	readonly operationScope: OperationValueScope;
	readonly caseDataScope: CaseDataScope;
}

/** A slot that is either absent or a full expression, with one gesture
 *  each way. Absence is a real authored state, so removing is confirmed. */
function OptionalExpressionSection({
	title,
	description,
	addLabel,
	clearLabel,
	clearTitle,
	clearConsequence,
	value,
	canEdit,
	seed,
	onChange,
	constraint,
	editorScope,
	ownerValues = false,
}: {
	readonly title: string;
	readonly description: string;
	readonly addLabel: string;
	readonly clearLabel: string;
	readonly clearTitle: string;
	readonly clearConsequence: string;
	readonly value: ValueExpression | undefined;
	readonly canEdit: boolean;
	readonly seed: () => ValueExpression;
	readonly onChange: (next: ValueExpression | undefined) => void;
	readonly constraint: ReturnType<typeof storageAssignmentConstraint>;
	readonly editorScope: EditorScope;
	readonly ownerValues?: boolean;
}) {
	const { addRef, onCleared } = useClearedSlotFocus(value);
	return (
		<Section
			title={title}
			description={description}
			action={
				value !== undefined && canEdit ? (
					<ClearConditionButton
						label={clearLabel}
						title={clearTitle}
						consequence={clearConsequence}
						finalFocus={() => addRef.current}
						onConfirm={() => {
							onCleared();
							onChange(undefined);
						}}
					/>
				) : undefined
			}
		>
			{value === undefined ? (
				<AddSlotButton
					ref={addRef}
					label={addLabel}
					disabled={!canEdit}
					onClick={() => onChange(seed())}
				/>
			) : (
				<ExpressionCardEditor
					value={value}
					onChange={onChange}
					constraint={constraint}
					{...editorScope}
					ownerValues={ownerValues}
				/>
			)}
		</Section>
	);
}

function WriteRow({
	write,
	canEdit,
	editorScope,
	destinationType,
	onChange,
	onRemove,
	removeRef,
}: {
	readonly write: CaseOperationWrite;
	readonly canEdit: boolean;
	readonly editorScope: EditorScope;
	/** The declared type of the property being written, when the catalog
	 *  knows one. Absent means a brand-new property: the batch declares
	 *  it, so any storable value is admissible. */
	readonly destinationType: CasePropertyDataType | undefined;
	readonly onChange: (next: CaseOperationWrite) => void;
	readonly onRemove: () => void;
	readonly removeRef?: React.Ref<HTMLButtonElement>;
}) {
	const conditionCleared = useClearedSlotFocus(write.condition);
	return (
		<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3 @sm:p-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3 className="min-w-0 break-words text-[14px] font-semibold text-nova-text">
					{casePropertyLabel(write.property)}
				</h3>
				{canEdit && (
					<Button
						ref={removeRef}
						type="button"
						variant="ghost-destructive"
						onClick={onRemove}
						aria-label={`Stop saving ${write.property}`}
					>
						<Icon icon={tablerTrash} width="14" height="14" />
						Stop saving this
					</Button>
				)}
			</div>
			<ExpressionCardEditor
				value={write.value}
				onChange={(value: ValueExpression) => onChange({ ...write, value })}
				constraint={storageAssignmentConstraint(
					destinationType === undefined ? [] : [destinationType],
				)}
				{...editorScope}
			/>
			<div className="mt-3 border-t border-white/[0.06] pt-3">
				{write.condition === undefined ? (
					<AddSlotButton
						ref={conditionCleared.addRef}
						label="Only save this sometimes"
						disabled={!canEdit}
						onClick={() =>
							onChange({
								...write,
								condition: firstComparisonDefault({
									...editorScope,
									knownInputs: [],
								}),
							})
						}
					/>
				) : (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-[13px] font-medium text-nova-text-secondary">
								Only saved when
							</p>
							{canEdit && (
								<ClearConditionButton
									label="Always save it"
									title="Always save this value?"
									consequence="It will be saved every time this change runs."
									finalFocus={() => conditionCleared.addRef.current}
									onConfirm={() => {
										conditionCleared.onCleared();
										onChange({ ...write, condition: undefined });
									}}
								/>
							)}
						</div>
						<PredicateWorkbench
							value={write.condition}
							onChange={(condition: Predicate) =>
								onChange({ ...write, condition })
							}
							rootLabel={`when ${write.property} is saved`}
							caseTypes={editorScope.caseTypes}
							currentCaseType={editorScope.currentCaseType}
							userProperties={editorScope.userProperties}
							formFields={editorScope.formFields}
							operationScope={editorScope.operationScope}
							caseDataScope={editorScope.caseDataScope}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
