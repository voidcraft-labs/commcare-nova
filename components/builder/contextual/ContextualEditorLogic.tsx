"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useBuilderEngine, useBuilderStore } from "@/hooks/useBuilder";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import type { Question } from "@/lib/schemas/blueprint";
import {
	assembleBlueprint,
	assembleForm,
	getEntityData,
} from "@/lib/services/normalizedState";
import type { QuestionPath } from "@/lib/services/questionPath";
import { AddPropertyButton } from "./AddPropertyButton";
import { RequiredSection } from "./RequiredSection";
import {
	addableTextFields,
	type FocusableFieldKey,
	fieldSupportedForType,
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

export function ContextualEditorLogic({ question }: QuestionEditorProps) {
	const selected = useBuilderStore((s) => s.selected);
	const builder = useBuilderEngine();
	const saveQuestion = useSaveQuestion();

	const questionPath = selected?.questionPath ?? ("" as QuestionPath);
	/** Tracks text fields (validation_msg) added via "Add Property". */
	const textField = useAddableField(questionPath);
	/** Tracks XPath fields added via "Add Property" — separate from text
	 *  fields so both can be pending simultaneously. */
	const xpathField = useAddableField(questionPath);

	const focusHint = useFocusHint(LOGIC_FIELDS);

	/** Context getter for XPath linting and autocomplete. Reads from the
	 *  store imperatively so the closure always reflects the latest state
	 *  without triggering re-renders on every entity change. */
	const getLintContext = useCallback((): XPathLintContext | undefined => {
		if (!selected || selected.formIndex === undefined) return undefined;
		const s = builder.store.getState();
		const moduleId = s.moduleOrder[selected.moduleIndex];
		if (!moduleId) return undefined;
		const mod = s.modules[moduleId];
		const formIds = s.formOrder[moduleId];
		const formId = formIds?.[selected.formIndex];
		if (!formId) return undefined;
		const formEntity = s.forms[formId];
		if (!formEntity) return undefined;
		const form = assembleForm(formEntity, formId, s.questions, s.questionOrder);
		const blueprint = assembleBlueprint(getEntityData(s));
		return { blueprint, form, moduleCaseType: mod?.caseType ?? undefined };
	}, [selected, builder]);

	/** Save handler for standard XPath fields (validation, relevant, etc.).
	 *  Empty values become null (field removal). Clears pending add-property state. */
	const saveXPath = useCallback(
		(field: string, value: string) => {
			saveQuestion(field, value || null);
			xpathField.clear();
		},
		[saveQuestion, xpathField],
	);

	if (!selected) return null;

	const type = question.type;

	/** XPath fields not yet set on this question, available to add.
	 *  Filtered by type support — only offer fields that CommCare honors
	 *  for this question type. Fields with existing values are still shown
	 *  (graceful degradation for stale data after type conversion). */
	const missingXPathFields = xpathFields.filter(
		(f) =>
			!question[f.field as keyof Question] &&
			xpathField.activeField !== f.field &&
			fieldSupportedForType(f.field, type),
	);

	/** Show "Validation Message" add button only when validation is present
	 *  or being added, AND the type actually supports validation (avoids
	 *  offering it alongside stale validation fields from type conversion). */
	const missingValidationMsg = addableTextFields.filter(
		(f) =>
			f.field === "validation_msg" &&
			!question.validation_msg &&
			textField.activeField !== "validation_msg" &&
			(question.validation || xpathField.activeField === "validation") &&
			fieldSupportedForType("validation", type),
	);

	/** Whether the field is visible — type supports it AND it either has a
	 *  value, is pending addition, or is being focus-restored. Type conversions
	 *  only happen within families with identical field support, so stale
	 *  fields from conversion are impossible. */
	const isVisible = (field: XPathFieldKey) =>
		fieldSupportedForType(field, type) &&
		(!!question[field] ||
			xpathField.activeField === field ||
			focusHint === field);

	/** Required follows the same visibility pattern as XPath fields: only
	 *  shown when it has a value or is being focus-restored from undo/redo.
	 *  "Add Property" saves required directly (toggled on), so no pending
	 *  addable state is needed — the value check covers it. */
	const showRequired =
		fieldSupportedForType("required", type) &&
		(!!question.required ||
			focusHint === "required" ||
			focusHint === "required_condition");

	/** Whether a Required "Add Property" button should be shown. */
	const missingRequired =
		fieldSupportedForType("required", type) && !question.required;

	const hasContent =
		question.required ||
		question.validation ||
		question.relevant ||
		question.default_value ||
		question.calculate ||
		xpathField.activeField;

	return (
		<div className="space-y-3">
			{/* ── All logic fields: required + standard XPath fields ── */}
			{/* AnimatePresence provides smooth height collapse on undo/redo removal
			    and on Add Property / dismiss transitions. */}
			<AnimatePresence>
				{showRequired && (
					<motion.div
						key="required"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						<RequiredSection
							required={question.required}
							getLintContext={getLintContext}
							focusHint={focusHint}
							dataFieldId="required"
						/>
					</motion.div>
				)}
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
			{(missingRequired ||
				missingXPathFields.length > 0 ||
				missingValidationMsg.length > 0) && (
				<div
					className={hasContent ? "pt-2 border-t border-nova-border/40" : ""}
				>
					<div className="flex flex-wrap gap-1.5">
						{missingRequired && (
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
