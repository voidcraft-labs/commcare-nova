"use client";
import { AnimatePresence, motion } from "motion/react";
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
	type FocusableFieldKey,
	type QuestionEditorProps,
	useAddableField,
	useFocusHint,
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
	dataFieldId,
	children,
}: {
	label: string;
	value: string;
	onSave: (value: string) => void;
	getLintContext: () => XPathLintContext | undefined;
	autoEdit: boolean;
	/** Undo/redo scroll + flash target — scoped to the editor, not the label. */
	dataFieldId?: string;
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
			<div data-field-id={dataFieldId}>
				<XPathField
					value={value}
					onSave={onSave}
					getLintContext={getLintContext}
					autoEdit={autoEdit}
					onEditingChange={setEditing}
				/>
			</div>
			{children}
		</div>
	);
}

/** Field keys owned by the Logic section — only these trigger focusHint clearing. */
const LOGIC_FIELDS = new Set<FocusableFieldKey>([
	"required",
	"required_condition",
	"validation",
	"validation_msg",
	"relevant",
	"default_value",
	"calculate",
]);

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

	const focusHint = useFocusHint(builder, LOGIC_FIELDS);

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

	/** Whether the field is visible (has a value, is pending addition, or is being focus-restored). */
	const isVisible = (field: XPathFieldKey) =>
		!!question[field] ||
		xpathField.activeField === field ||
		focusHint === field;

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
				focusHint={focusHint}
				dataFieldId="required"
			/>

			{/* ── Standard XPath fields: validation (with validation_msg), relevant, default_value, calculate ── */}
			{/* AnimatePresence provides smooth height collapse on undo/redo removal
			    instead of an abrupt vanish when flushSync commits state synchronously. */}
			<AnimatePresence>
				{isVisible("validation") && (
					<motion.div
						key="validation"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<XPathSection
							label="Validation"
							dataFieldId="validation"
							value={question.validation ?? ""}
							onSave={(v) => saveXPath("validation", v)}
							getLintContext={getLintContext}
							autoEdit={
								xpathField.activeField === "validation" ||
								focusHint === "validation"
							}
						>
							{(question.validation_msg ||
								textField.activeField === "validation_msg" ||
								focusHint === "validation_msg") && (
								<div className="mt-1">
									<EditableText
										label="Validation Message"
										dataFieldId="validation_msg"
										value={question.validation_msg ?? ""}
										onSave={(v) => {
											saveQuestion("validation_msg", v || null);
											textField.clear();
										}}
										autoFocus={
											textField.activeField === "validation_msg" ||
											focusHint === "validation_msg"
										}
										onEmpty={
											textField.activeField === "validation_msg"
												? textField.clear
												: undefined
										}
									/>
								</div>
							)}
						</XPathSection>
					</motion.div>
				)}
				{isVisible("relevant") && (
					<motion.div
						key="relevant"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<XPathSection
							label="Show When"
							dataFieldId="relevant"
							value={question.relevant ?? ""}
							onSave={(v) => saveXPath("relevant", v)}
							getLintContext={getLintContext}
							autoEdit={
								xpathField.activeField === "relevant" ||
								focusHint === "relevant"
							}
						/>
					</motion.div>
				)}
				{isVisible("default_value") && (
					<motion.div
						key="default_value"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<XPathSection
							label="Default Value"
							dataFieldId="default_value"
							value={question.default_value ?? ""}
							onSave={(v) => saveXPath("default_value", v)}
							getLintContext={getLintContext}
							autoEdit={
								xpathField.activeField === "default_value" ||
								focusHint === "default_value"
							}
						/>
					</motion.div>
				)}
				{isVisible("calculate") && (
					<motion.div
						key="calculate"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<XPathSection
							label="Calculate"
							dataFieldId="calculate"
							value={question.calculate ?? ""}
							onSave={(v) => saveXPath("calculate", v)}
							getLintContext={getLintContext}
							autoEdit={
								xpathField.activeField === "calculate" ||
								focusHint === "calculate"
							}
						/>
					</motion.div>
				)}
			</AnimatePresence>

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
