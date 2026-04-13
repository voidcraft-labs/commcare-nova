"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useContext, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useSaveQuestion } from "@/hooks/useSaveQuestion";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { useSelectedQuestion } from "@/lib/routing/hooks";
import type { Question } from "@/lib/schemas/blueprint";
import type { NormalizedData } from "@/lib/services/normalizedState";
import {
	assembleBlueprint,
	assembleForm,
	getEntityData,
} from "@/lib/services/normalizedState";
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
	const selected = useSelectedQuestion();
	const saveQuestion = useSaveQuestion(selected?.uuid);

	/** Tracks text fields (validation_msg) added via "Add Property". */
	const textField = useAddableField(selected?.uuid ?? "");
	/** Tracks XPath fields added via "Add Property" — separate from text
	 *  fields so both can be pending simultaneously. */
	const xpathField = useAddableField(selected?.uuid ?? "");

	const focusHint = useFocusHint(LOGIC_FIELDS);

	/** The doc store context for imperative state reads (lint context). */
	const docStore = useContext(BlueprintDocContext);

	/** Context getter for XPath linting and autocomplete. Reads from the
	 *  doc store imperatively so the closure always reflects the latest state
	 *  without triggering re-renders on every entity change. */
	const getLintContext = useCallback((): XPathLintContext | undefined => {
		if (!docStore || !selected) return undefined;
		const s = docStore.getState();
		/* Cast to NormalizedData — Uuid-branded keys are subtypes of string,
		 * and the extra BlueprintDocState fields (apply, applyMany) are harmless. */
		const nd = s as unknown as NormalizedData;
		/* Find the form that owns this question by walking questionOrder
		 * upward from the question uuid to a form uuid. */
		let parentUuid: Uuid | undefined;
		for (const [pUuid, order] of Object.entries(s.questionOrder)) {
			if (order.includes(selected.uuid as Uuid)) {
				parentUuid = pUuid as Uuid;
				break;
			}
		}
		/* Walk up until we reach a form entity (not a group/repeat). */
		const visited = new Set<string>();
		while (parentUuid && !s.forms[parentUuid]) {
			if (visited.has(parentUuid)) break;
			visited.add(parentUuid);
			let next: Uuid | undefined;
			for (const [pUuid, order] of Object.entries(s.questionOrder)) {
				if (order.includes(parentUuid)) {
					next = pUuid as Uuid;
					break;
				}
			}
			parentUuid = next;
		}
		if (!parentUuid) return undefined;
		const formEntity = s.forms[parentUuid];
		if (!formEntity) return undefined;
		/* Find the module that owns this form. */
		let moduleUuid: Uuid | undefined;
		for (const [mUuid, formUuids] of Object.entries(s.formOrder)) {
			if (formUuids.includes(parentUuid)) {
				moduleUuid = mUuid as Uuid;
				break;
			}
		}
		const mod = moduleUuid ? s.modules[moduleUuid] : undefined;
		const form = assembleForm(
			formEntity,
			parentUuid,
			nd.questions,
			nd.questionOrder,
		);
		const blueprint = assembleBlueprint(getEntityData(nd));
		return { blueprint, form, moduleCaseType: mod?.caseType ?? undefined };
	}, [docStore, selected]);

	/** Save handler for standard XPath fields (validation, relevant, etc.).
	 *  Empty values become undefined (field removal). Clears pending add-property state. */
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
			question.validation &&
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
			{/* initial={false} skips entrance animations for fields already present
			    when the panel mounts — only fields added/removed after mount animate
			    (Add Property, undo/redo, clearing a value). Without this, opening the
			    panel replays height-expand on every existing field. */}
			<AnimatePresence initial={false}>
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
							questionUuid={selected.uuid}
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
