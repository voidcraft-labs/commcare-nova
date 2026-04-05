"use client";
import { useCallback, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { AddPropertyButton } from "./AddPropertyButton";
import { RequiredSection } from "./RequiredSection";
import {
	addableTextFields,
	type QuestionEditorProps,
	useAddableField,
	type XPathFieldKey,
	xpathFields,
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
	const [editing, setEditing] = useState(false);

	return (
		<div>
			{/* Visual heading only — XPathField is a CodeMirror editor, not a native
           input, so <label> can't associate with it and misleads screen readers. */}
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
				{label}
				{editing && <SaveShortcutHint />}
			</span>
			<XPathField
				value={value}
				onSave={onSave}
				getLintContext={getLintContext}
				autoEdit={autoEdit}
				onEditingChange={setEditing}
			/>
			{children}
		</div>
	);
}

export function ContextualEditorLogic({
	question,
	builder,
}: QuestionEditorProps) {
	const selected = builder.selected;
	const mb = builder.mb;
	const saveQuestion = useSaveQuestion(builder);

	const questionPath = selected?.questionPath ?? ("" as QuestionPath);
	/** Tracks text fields (validation_msg) added via "Add Property". */
	const textField = useAddableField(questionPath);
	/** Tracks XPath fields added via "Add Property" — separate from text
	 *  fields so both can be pending simultaneously. */
	const xpathField = useAddableField(questionPath);

	/** Context getter for XPath linting and autocomplete. */
	const getLintContext = useCallback((): XPathLintContext | undefined => {
		if (!selected || !mb || selected.formIndex === undefined) return undefined;
		const blueprint = mb.getBlueprint();
		const form = mb.getForm(selected.moduleIndex, selected.formIndex);
		const mod = mb.getModule(selected.moduleIndex);
		if (!form) return undefined;
		return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined };
	}, [mb, selected]);

	/** Save handler for standard XPath fields (validation, relevant, etc.).
	 *  Empty values become null (field removal). Clears pending add-property state. */
	const saveXPath = useCallback(
		(field: string, value: string) => {
			saveQuestion(field, value || null);
			xpathField.clear();
		},
		[saveQuestion, xpathField],
	);

	if (!selected || !mb) return null;

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
			<RequiredSection
				required={question.required}
				builder={builder}
				getLintContext={getLintContext}
			/>

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
			{(missingXPathFields.length > 0 || missingValidationMsg.length > 0) && (
				<div
					className={hasContent ? "pt-2 border-t border-nova-border/40" : ""}
				>
					<div className="flex flex-wrap gap-1.5">
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
