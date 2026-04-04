"use client";
import { useCallback } from "react";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { Icon } from "@iconify/react/offline";
import ciTrashFull from "@iconify-icons/ci/trash-full";
import type { Question } from "@/lib/schemas/blueprint";
import { EditableText } from "@/components/builder/EditableText";
import { Toggle } from "@/components/ui/Toggle";
import { XPathField } from "@/components/builder/XPathField";
import { AddPropertyButton } from "./AddPropertyButton";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import {
	type QuestionEditorProps,
	type XPathFieldKey,
	useAddableField,
	xpathFields,
	addableTextFields,
} from "./shared";

/**
 * Renders a labeled XPath expression field with auto-edit support.
 * Used for validation, relevant, default_value, and calculate fields —
 * all share the same label + XPathField + optional children pattern.
 */
function XPathSection({
	label,
	value,
	onSave,
	getLintContext,
	autoEdit,
	children,
}: {
	label: string;
	value: string;
	onSave: (value: string) => void;
	getLintContext: () => XPathLintContext | undefined;
	autoEdit: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div>
			{/* Visual heading only — XPathField is a CodeMirror editor, not a native
           input, so <label> can't associate with it and misleads screen readers. */}
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 block">
				{label}
			</span>
			<XPathField
				value={value}
				onSave={onSave}
				getLintContext={getLintContext}
				autoEdit={autoEdit}
			/>
			{children}
		</div>
	);
}

export function ContextualEditorLogic({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected!;
	const mb = builder.mb!;
	const saveQuestion = useSaveQuestion(builder);

	/** Tracks text fields (validation_msg) added via "Add Property". */
	const textField = useAddableField(selected.questionPath!);
	/** Tracks XPath fields added via "Add Property" — separate from text
	 *  fields so both can be pending simultaneously. */
	const xpathField = useAddableField(selected.questionPath!);

	/** Context getter for XPath linting and autocomplete. */
	const getLintContext = useCallback((): XPathLintContext | undefined => {
		const blueprint = mb.getBlueprint();
		const form = mb.getForm(selected.moduleIndex, selected.formIndex!);
		const mod = mb.getModule(selected.moduleIndex);
		if (!form) return undefined;
		return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined };
	}, [mb, selected.moduleIndex, selected.formIndex]);

	const hasRequiredCondition =
		!!question.required && question.required !== "true()";

	/** Save handler for XPath fields. Clears pending state after save.
	 *  Empty values fall back to true() for required, null (removal) for others. */
	const saveXPath = useCallback(
		(field: string, value: string) => {
			if (field === "required") {
				saveQuestion("required", value || "true()");
			} else {
				saveQuestion(field, value || null);
			}
			xpathField.clear();
		},
		[saveQuestion, xpathField],
	);

	/** XPath fields not yet set on this question, available to add. */
	const missingXPathFields = xpathFields.filter(
		(f) =>
			!question[f.field as keyof Question] &&
			xpathField.activeField !== f.field,
	);

	/** Show "Validation Message" add button only when validation is present or being added. */
	const missingValidationMsg = addableTextFields.filter(
		(f) =>
			f.field === "validation_msg" &&
			!question.validation_msg &&
			textField.activeField !== "validation_msg" &&
			(question.validation || xpathField.activeField === "validation"),
	);

	/** Whether the field is visible (has a value or is pending addition). */
	const isVisible = (field: XPathFieldKey) =>
		!!question[field] || xpathField.activeField === field;

	const hasContent =
		question.required ||
		question.validation ||
		question.relevant ||
		question.default_value ||
		question.calculate ||
		xpathField.activeField;

	return (
		<div className="space-y-3">
			{/* ── Required: toggle + optional conditional XPath expression ── */}
			{question.required && (
				<div>
					<div className="flex items-center justify-between mb-1">
						{/* Visual heading — Toggle is a custom component, not a native input */}
						<span className="text-xs text-nova-text-muted uppercase tracking-wider">
							Required
						</span>
						<Toggle enabled onToggle={() => saveQuestion("required", null)} />
					</div>
					{hasRequiredCondition || xpathField.activeField === "required" ? (
						<div className="flex items-center gap-1.5 group/condition">
							<div className="flex-1 min-w-0">
								<XPathField
									value={hasRequiredCondition ? question.required! : ""}
									onSave={(v) => saveXPath("required", v)}
									getLintContext={getLintContext}
									autoEdit={xpathField.activeField === "required"}
								/>
							</div>
							{hasRequiredCondition && (
								<button
									type="button"
									onClick={() => saveQuestion("required", "true()")}
									aria-label="Remove condition"
									className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover/condition:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
									tabIndex={-1}
								>
									<Icon icon={ciTrashFull} width="12" height="12" />
								</button>
							)}
						</div>
					) : (
						<AddPropertyButton
							label="Condition"
							onClick={() => xpathField.activate("required")}
						/>
					)}
				</div>
			)}

			{/* ── Standard XPath fields: validation (with validation_msg), relevant, default_value, calculate ── */}
			{isVisible("validation") && (
				<XPathSection
					label="Validation"
					value={question.validation ?? ""}
					onSave={(v) => saveXPath("validation", v)}
					getLintContext={getLintContext}
					autoEdit={xpathField.activeField === "validation"}
				>
					{(question.validation_msg ||
						textField.activeField === "validation_msg") && (
						<div className="mt-1">
							<EditableText
								label="Validation Message"
								value={question.validation_msg ?? ""}
								onSave={(v) => {
									saveQuestion("validation_msg", v || null);
									textField.clear();
								}}
								autoFocus={textField.activeField === "validation_msg"}
								onEmpty={
									textField.activeField === "validation_msg"
										? textField.clear
										: undefined
								}
							/>
						</div>
					)}
				</XPathSection>
			)}
			{isVisible("relevant") && (
				<XPathSection
					label="Show When"
					value={question.relevant ?? ""}
					onSave={(v) => saveXPath("relevant", v)}
					getLintContext={getLintContext}
					autoEdit={xpathField.activeField === "relevant"}
				/>
			)}
			{isVisible("default_value") && (
				<XPathSection
					label="Default Value"
					value={question.default_value ?? ""}
					onSave={(v) => saveXPath("default_value", v)}
					getLintContext={getLintContext}
					autoEdit={xpathField.activeField === "default_value"}
				/>
			)}
			{isVisible("calculate") && (
				<XPathSection
					label="Calculate"
					value={question.calculate ?? ""}
					onSave={(v) => saveXPath("calculate", v)}
					getLintContext={getLintContext}
					autoEdit={xpathField.activeField === "calculate"}
				/>
			)}

			{/* ── Add Property buttons for missing fields ── */}
			{(!question.required ||
				missingXPathFields.length > 0 ||
				missingValidationMsg.length > 0) && (
				<div
					className={hasContent ? "pt-2 border-t border-nova-border/40" : ""}
				>
					<div className="flex flex-wrap gap-1.5">
						{!question.required && (
							<AddPropertyButton
								label="Required"
								onClick={() => saveQuestion("required", "true()")}
							/>
						)}
						{missingValidationMsg.map(({ field, label }) => (
							<AddPropertyButton
								key={field}
								label={label}
								onClick={() => textField.activate(field)}
							/>
						))}
						{missingXPathFields.map(({ field, label }) => (
							<AddPropertyButton
								key={field}
								label={label}
								onClick={() => xpathField.activate(field)}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
