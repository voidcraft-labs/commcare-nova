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
// form answers this change may read (narrowed by its multiplicity — see
// `formFieldScope.ts`), and the submission's own vocabulary (the acting
// user, no owner, an earlier create's case). Those two together are what
// let the shared editor offer a form answer at all.

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
import { seedLiteralForProperty } from "@/components/builder/shared/cards/reseed";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import type { OperationValueScope } from "@/components/builder/shared/expressionEditorSchemas";
import { PredicateWorkbench } from "@/components/builder/shared/PredicateWorkbench";
import { Button } from "@/components/shadcn/button";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { useEffectiveCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { useFormFieldEntries } from "@/lib/doc/hooks/useFormFieldEntries";
import type { Uuid } from "@/lib/doc/types";
import {
	type CaseOperation,
	type CaseOperationWrite,
	type CaseProperty,
	type CasePropertyDataType,
	type CaseType,
	effectiveDataType,
} from "@/lib/domain";
import {
	actingUser,
	literal,
	type Predicate,
	storageAssignmentConstraint,
	term,
	textShapedConstraint,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useNavigate } from "@/lib/routing/hooks";
import { useCanEdit } from "@/lib/session/hooks";
import { operationFormFieldDecls } from "./formFieldScope";
import { operationSentence } from "./operationSentence";
import { seedCaseOperationWrite } from "./seeds";
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

	const operations = view.operations;
	const index = operations.findIndex(
		(candidate) => candidate.uuid === operationUuid,
	);
	const operation = index < 0 ? undefined : operations[index];

	const fieldEntries = useFormFieldEntries(formUuid);
	const formFields = useMemo(
		() => operationFormFieldDecls(fieldEntries, operation?.forEach?.repeat),
		[fieldEntries, operation?.forEach?.repeat],
	);

	/* Only the creates BEFORE this one are in scope — the same set the
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

	const commit = (next: CaseOperation) => {
		const outcome = view.update(next);
		setRefusal(outcome.ok ? undefined : outcome.messages.join(" "));
	};

	const editorScope = {
		caseTypes,
		currentCaseType: destination,
		formFields,
		operationScope,
	} as const;

	return (
		<ContentFrame width="3xl" className="px-6 pb-24 pt-6">
			<div className="mb-5 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="ghost"
					size="xl"
					onClick={backToList}
					className="-ml-2 text-nova-text-secondary"
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
						size="xl"
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
						size="xl"
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
					className="mt-1 font-display text-2xl font-semibold tracking-tight text-nova-text outline-none"
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

			<Section
				title="When this runs"
				description={
					operation.condition === undefined
						? "Every time this form is submitted."
						: "Only when this is true of the submitted answers."
				}
				action={
					operation.condition !== undefined && canEdit ? (
						<ClearConditionButton
							label="Always run"
							title="Always run this change?"
							consequence="It will happen on every submission of this form."
							onConfirm={() => commit({ ...operation, condition: undefined })}
						/>
					) : undefined
				}
			>
				{operation.condition === undefined ? (
					<AddSlotButton
						label="Add a condition"
						disabled={!canEdit}
						onClick={() =>
							commit({
								...operation,
								condition: firstComparisonDefault({
									caseTypes,
									currentCaseType: destination,
									knownInputs: [],
									caseDataScope: "per-case",
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
						currentCaseType={destination}
						formFields={formFields}
						operationScope={operationScope}
					/>
				)}
			</Section>

			{operation.target.kind === "expression" && (
				<Section
					title="Which case to change"
					description="Work out the case this change acts on. The result must be a case id."
				>
					<ExpressionCardEditor
						value={operation.target.expr}
						onChange={(expr: ValueExpression) =>
							commit({ ...operation, target: { kind: "expression", expr } })
						}
						constraint={storageAssignmentConstraint(["text"])}
						{...editorScope}
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
						onChange={(name: ValueExpression) => commit({ ...operation, name })}
						constraint={textShapedConstraint()}
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
					canEdit={canEdit}
					seed={() => term(literal(""))}
					onChange={(rename) => commit({ ...operation, rename })}
					constraint={textShapedConstraint()}
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
					canEdit={canEdit}
					seed={() => actingUser()}
					onChange={(owner) => commit({ ...operation, owner })}
					constraint={textShapedConstraint()}
					editorScope={editorScope}
				/>
			)}

			<Section
				title="What it saves"
				description={
					destinationType === undefined
						? `Values saved onto the ${destination} case.`
						: `Values saved onto the ${destination} case. They stay on the case after the form is submitted.`
				}
			>
				<div className="space-y-3">
					{(operation.writes ?? []).map((write, writeIndex) => (
						<WriteRow
							key={write.property}
							write={write}
							canEdit={canEdit}
							editorScope={editorScope}
							destinationType={declaredPropertyType(
								destinationType,
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
							onRemove={() =>
								commit({
									...operation,
									writes: (operation.writes ?? []).filter(
										(_, i) => i !== writeIndex,
									),
								})
							}
						/>
					))}
					{canEdit && (
						<WritePropertyPicker
							caseTypeName={destination}
							alreadyWritten={
								new Set((operation.writes ?? []).map((write) => write.property))
							}
							onChoose={(property) =>
								commit({
									...operation,
									writes: [
										...(operation.writes ?? []),
										seedCaseOperationWrite(
											property,
											term(
												seedLiteralForProperty(
													destinationType?.properties.find(
														(candidate) => candidate.name === property,
													),
												),
											),
										),
									],
								})
							}
						/>
					)}
				</div>
			</Section>
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
					<h2 className="font-display text-[17px] font-semibold text-nova-text">
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
}: {
	readonly label: string;
	readonly disabled: boolean;
	readonly onClick: () => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="xl"
			disabled={disabled}
			onClick={onClick}
			className="w-full border-dashed border-white/[0.10] bg-transparent text-[14px] text-nova-text-muted not-disabled:hover:border-nova-violet/30 not-disabled:hover:bg-nova-violet/[0.05] not-disabled:hover:text-nova-violet-bright dark:bg-transparent dark:not-disabled:hover:bg-nova-violet/[0.05]"
		>
			<Icon icon={tablerPlus} width="14" height="14" />
			{label}
		</Button>
	);
}

interface EditorScope {
	readonly caseTypes: ReturnType<typeof useEffectiveCaseTypes>;
	readonly currentCaseType: string;
	readonly formFields: ReturnType<typeof operationFormFieldDecls>;
	readonly operationScope: OperationValueScope;
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
	readonly constraint: ReturnType<typeof textShapedConstraint>;
	readonly editorScope: EditorScope;
}) {
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
						onConfirm={() => onChange(undefined)}
					/>
				) : undefined
			}
		>
			{value === undefined ? (
				<AddSlotButton
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
}: {
	readonly write: CaseOperationWrite;
	readonly canEdit: boolean;
	readonly editorScope: EditorScope;
	/** The declared type of the property being written, when the catalog
	 *  knows one. Absent means a brand-new property — the batch declares
	 *  it, so any storable value is admissible. */
	readonly destinationType: CasePropertyDataType | undefined;
	readonly onChange: (next: CaseOperationWrite) => void;
	readonly onRemove: () => void;
}) {
	return (
		<div className="rounded-xl border border-white/[0.07] bg-nova-deep/30 p-3 @sm:p-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h3 className="min-w-0 break-words text-[14px] font-semibold text-nova-text">
					{write.property}
				</h3>
				{canEdit && (
					<Button
						type="button"
						variant="ghost"
						size="xl"
						onClick={onRemove}
						className="px-3 text-sm text-nova-rose not-disabled:hover:bg-nova-rose/[0.08] not-disabled:hover:text-nova-rose"
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
						label="Only save this sometimes"
						disabled={!canEdit}
						onClick={() =>
							onChange({
								...write,
								condition: firstComparisonDefault({
									caseTypes: editorScope.caseTypes,
									currentCaseType: editorScope.currentCaseType,
									knownInputs: [],
									caseDataScope: "per-case",
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
									onConfirm={() => onChange({ ...write, condition: undefined })}
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
							formFields={editorScope.formFields}
							operationScope={editorScope.operationScope}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

/** The declared type of one property on the destination case type. */
function declaredPropertyType(
	caseType: CaseType | undefined,
	property: string,
): CasePropertyDataType | undefined {
	const declared: CaseProperty | undefined = caseType?.properties.find(
		(candidate) => candidate.name === property,
	);
	return declared === undefined ? undefined : effectiveDataType(declared);
}
