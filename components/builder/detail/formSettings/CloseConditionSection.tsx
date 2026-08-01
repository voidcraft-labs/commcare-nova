"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { FieldPicker } from "@/components/ui/FieldPicker";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFieldEntrySource } from "@/lib/doc/hooks/useFieldEntrySource";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import {
	type CommitOutcome,
	projectProseTemplate,
	type Uuid,
} from "@/lib/domain";
import { InlineField } from "./InlineField";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import type { FormSettingsSectionProps } from "./types";

/** Two-valued mode switch: auto-close ("always") vs. predicate ("conditional"). */
type CloseMode = "always" | "conditional";

/** Options for the top-level close-behavior dropdown. */
const CLOSE_MODE_OPTIONS: ReadonlyArray<SelectMenuOption<CloseMode>> = [
	{ value: "always", label: "Always" },
	{ value: "conditional", label: "When condition is met" },
];

/** Operator options for the conditional close predicate. `=` is string
 *  equality; `selected` invokes HQ's `selected()` XPath function on a
 *  multi-select source field. */
type CloseOperator = "=" | "selected";

const OPERATOR_OPTIONS: ReadonlyArray<SelectMenuOption<CloseOperator>> = [
	{ value: "=", label: "is" },
	{ value: "selected", label: "has selected" },
];

interface CloseConditionDraft {
	readonly field: Uuid | null;
	readonly answer: string;
	readonly operator: CloseOperator;
}

interface FormCloseConditionDraft {
	readonly formUuid: Uuid;
	readonly value: CloseConditionDraft;
}

/**
 * Close-behavior dropdown rendered only for close forms. The top-level
 * mode switch toggles between "Always" (the default — the form closes
 * the case unconditionally on submit) and "When condition is met". The
 * conditional branch reveals a field picker, an operator selector
 * ("is" / "has selected"), and a value input. When the referenced field
 * carries a finite option list, the value selector swaps to a dropdown
 * of those options; otherwise a plain text input is shown. HQ wraps
 * string values in quotes automatically, so users type literal values
 * rather than XPath expressions.
 */
export function CloseConditionSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	/* Two flavors: the mode SelectMenu has no contextual error surface, so
	 * its dispatch announces (toast); the condition editors forward their
	 * outcome inline, so theirs stays quiet. */
	const { updateForm: updateFormAction, inline } = useBlueprintMutations();
	const triggerId = useId();

	/* FieldPicker and close-field resolution share one shallow-stable owning-doc
	 * slice. It carries the field tree plus the form/worker-information context
	 * needed to project identity-backed labels through their current names. */
	const fieldEntrySource = useFieldEntrySource();
	/* The picker projector deliberately accepts only the narrow field shape it
	 * needs. Keep the domain-typed field map for kind-specific option reads. */
	const { fields } = useFieldsAndOrder();
	/** A refusal from the picker or the operator/value menus — controls
	 *  with no inline channel of their own — rendered beneath the
	 *  condition card. The free-text answer `InlineField` presents its
	 *  own outcome and bypasses this. */
	const [conditionRejection, setConditionRejection] = useState<string | null>(
		null,
	);
	/* Switching from Always opens a local, incomplete draft. It does not emit a
	 * mutation until both required values exist, so the persisted document
	 * never carries an empty/fabricated UUID or an incomplete close condition. */
	const [draftState, setDraftState] = useState<FormCloseConditionDraft | null>(
		null,
	);
	const draft =
		draftState?.formUuid === formUuid ? draftState.value : undefined;
	const savedCondition = form?.closeCondition;
	const condition: CloseConditionDraft | undefined =
		savedCondition === undefined
			? draft
			: {
					field: savedCondition.field,
					answer: savedCondition.answer,
					operator: savedCondition.operator ?? "=",
				};

	/* A peer-authored or successful local condition supersedes any incomplete
	 * local draft for this form. */
	useEffect(() => {
		if (savedCondition !== undefined && draftState?.formUuid === formUuid) {
			setDraftState(null);
		}
	}, [draftState?.formUuid, formUuid, savedCondition]);

	const closeFieldRef = condition?.field;
	const closeField = closeFieldRef ? fields[closeFieldRef] : undefined;

	/* Resolve the referenced field to check if it has selectable options. */
	const selectedFieldOptions = useMemo(() => {
		if (!closeField) return undefined;
		// `options` only exists on select kinds; narrow via `in`. Array position
		// is the same sequence the field renders.
		return "optionsSource" in closeField &&
			closeField.optionsSource.kind === "inline" &&
			closeField.optionsSource.options.length > 0
			? closeField.optionsSource.options.map((option) => ({
					...option,
					label: projectProseTemplate(option.label, fieldEntrySource).text,
				}))
			: undefined;
	}, [closeField, fieldEntrySource]);

	if (form?.type !== "close") return null;

	const currentMode: CloseMode = condition ? "conditional" : "always";
	const operator: CloseOperator = condition?.operator ?? "=";

	const handleSelect = (mode: CloseMode) => {
		// The mode flip replaces (or removes) the whole condition — any
		// refusal that pointed at the old condition no longer applies.
		setConditionRejection(null);
		if (mode === "always") {
			setDraftState(null);
			if (savedCondition !== undefined) {
				updateFormAction(formUuid, { closeCondition: null });
			}
		} else {
			setDraftState({
				formUuid,
				value: { field: null, answer: "", operator: "=" },
			});
		}
	};

	/* Dispatch wrapper for the picker and the operator/value menus —
	 * controls with no inline channel of their own. The refusal lands in
	 * the section-level notice beneath the condition card. */
	const updateConditionWithNotice = (
		patch: Partial<{
			field: Uuid;
			answer: string;
			operator: CloseOperator;
		}>,
	) => {
		const outcome = updateCondition(patch);
		setConditionRejection(
			outcome === undefined || outcome.ok
				? null
				: (outcome.messages[0] ?? null),
		);
	};

	const updateCondition = (
		patch: Partial<{
			field: Uuid;
			answer: string;
			operator: CloseOperator;
		}>,
	): CommitOutcome | undefined => {
		const current =
			condition ?? ({ field: null, answer: "", operator: "=" } as const);
		const next: CloseConditionDraft = {
			...current,
			...patch,
		};
		if (savedCondition === undefined) {
			setDraftState({ formUuid, value: next });
			if (next.field === null || next.answer.length === 0) return undefined;
		}
		if (next.field === null) return undefined;

		const outcome = inline.updateForm(formUuid, {
			closeCondition: {
				field: next.field,
				answer: next.answer,
				...(next.operator !== "=" && { operator: next.operator }),
			},
		});
		if (outcome.ok) setDraftState(null);
		return outcome;
	};

	const answer = condition?.answer ?? "";

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary mb-1.5 block"
			>
				Close Behavior
			</label>
			<SelectMenu
				triggerId={triggerId}
				value={currentMode}
				options={CLOSE_MODE_OPTIONS}
				onChange={handleSelect}
			/>

			{/* Conditional close fields — field ID, operator, value */}
			<AnimatePresence>
				{condition && (
					<motion.div
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<div className="space-y-2 mt-2 rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
							{/* Field picker — autocomplete of form fields. Reads the
							 *  doc's normalized fields + order maps directly. */}
							<FieldPicker
								source={fieldEntrySource}
								parentUuid={formUuid}
								value={condition.field}
								onChange={(uuid) => updateConditionWithNotice({ field: uuid })}
								label="Field"
								placeholder="Search fields..."
								required
							/>

							{/* Operator — "is" (=) vs "has selected" (selected) */}
							<div>
								<span className="text-xs text-nova-text-muted mb-0.5 block">
									Operator
								</span>
								<SelectMenu
									value={operator}
									options={OPERATOR_OPTIONS}
									onChange={(v) => updateConditionWithNotice({ operator: v })}
								/>
							</div>

							{/* Value — dropdown of field options when available, free text otherwise.
							 * HQ wraps the value in quotes automatically (it's a string literal,
							 * not an XPath expression), so users type plain values like "yes". */}
							{selectedFieldOptions ? (
								<div>
									<span className="text-xs text-nova-text-muted mb-0.5 block">
										Value <span className="text-nova-rose ml-0.5">*</span>
									</span>
									<SelectMenu
										value={answer}
										options={selectedFieldOptions}
										onChange={(v) => updateConditionWithNotice({ answer: v })}
										renderTrigger={(v) => {
											const opt = selectedFieldOptions.find(
												(o) => o.value === v,
											);
											return (
												<span
													className={
														v
															? "font-mono text-nova-violet-bright"
															: "text-nova-text-muted"
													}
												>
													{v ? (opt?.label ?? v) : "Select a value..."}
												</span>
											);
										}}
										renderItem={(opt) => {
											const source = selectedFieldOptions.find(
												(o) => o.value === opt.value,
											);
											const showSuffix =
												source && source.label !== source.value;
											return (
												<>
													<span className="font-mono text-xs">{opt.value}</span>
													{showSuffix && (
														<span className="text-xs text-nova-text-muted ml-auto">
															{source.label}
														</span>
													)}
												</>
											);
										}}
									/>
								</div>
							) : (
								<InlineField
									label="Value"
									value={condition.answer}
									onChange={(v) => updateCondition({ answer: v })}
									mono
									required
									placeholder="Plain text value"
								/>
							)}

							{/* A refusal from the picker or menus explains itself
							 * here — those controls have no input of their own to
							 * anchor the finding to. */}
							<RejectionInline message={conditionRejection} />
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
