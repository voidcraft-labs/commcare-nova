"use client";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo } from "react";
import { FieldPicker } from "@/components/ui/FieldPicker";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { useFieldsAndOrder } from "@/lib/doc/hooks/useFieldsAndOrder";
import { asUuid } from "@/lib/doc/types";
import { findFieldById } from "./findFieldById";
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
	const { updateForm: updateFormAction } = useBlueprintMutations();
	const triggerId = useId();

	/* Subscribe to the doc's normalized field + order maps. `useFieldsAndOrder`
	 * runs shallow equality over the returned `{fields, fieldOrder}` pair so
	 * re-renders only fire when one of the two maps changes identity — Immer
	 * structural sharing keeps them stable through unrelated edits.
	 * FieldPicker + close-field resolution both consume the same slice so
	 * the doc walks once per render. */
	const { fields, fieldOrder } = useFieldsAndOrder();
	const closeFieldId = form?.closeCondition?.field;

	/* Resolve the referenced field to check if it has selectable options. */
	const selectedFieldOptions = useMemo(() => {
		if (!closeFieldId) return undefined;
		const found = findFieldById(fields, fieldOrder, formUuid, closeFieldId);
		if (!found) return undefined;
		// `options` only exists on select kinds; narrow via `in`.
		return "options" in found && found.options && found.options.length > 0
			? found.options
			: undefined;
	}, [closeFieldId, fields, fieldOrder, formUuid]);

	if (form?.type !== "close") return null;

	const currentMode: CloseMode = form.closeCondition ? "conditional" : "always";
	const operator: CloseOperator = form.closeCondition?.operator ?? "=";

	const handleSelect = (mode: CloseMode) => {
		if (mode === "always") {
			updateFormAction(asUuid(formUuid), { closeCondition: undefined });
		} else {
			updateFormAction(asUuid(formUuid), {
				closeCondition: { field: "", answer: "" },
			});
		}
	};

	const updateCondition = (
		patch: Partial<{
			field: string;
			answer: string;
			operator: CloseOperator;
		}>,
	) => {
		const current = form.closeCondition ?? { field: "", answer: "" };
		updateFormAction(asUuid(formUuid), {
			closeCondition: { ...current, ...patch },
		});
	};

	const answer = form.closeCondition?.answer ?? "";

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block"
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
				{form.closeCondition && (
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
								source={{ fields, fieldOrder }}
								parentUuid={formUuid}
								value={form.closeCondition.field}
								onChange={(v) => updateCondition({ field: v })}
								label="Field"
								placeholder="Search fields..."
								required
							/>

							{/* Operator — "is" (=) vs "has selected" (selected) */}
							<div>
								<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 block">
									Operator
								</span>
								<SelectMenu
									value={operator}
									options={OPERATOR_OPTIONS}
									onChange={(v) => updateCondition({ operator: v })}
								/>
							</div>

							{/* Value — dropdown of field options when available, free text otherwise.
							 * HQ wraps the value in quotes automatically (it's a string literal,
							 * not an XPath expression), so users type plain values like "yes". */}
							{selectedFieldOptions ? (
								<div>
									<span className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 block">
										Value <span className="text-nova-rose ml-0.5">*</span>
									</span>
									<SelectMenu
										value={answer}
										options={selectedFieldOptions}
										onChange={(v) => updateCondition({ answer: v })}
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
									value={form.closeCondition.answer}
									onChange={(v) => updateCondition({ answer: v })}
									mono
									required
									placeholder="Plain text value"
								/>
							)}
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
