import { useEffect, useState } from "react";
import type { Question } from "@/lib/schemas/blueprint";
import type { Builder } from "@/lib/services/builder";
import type { MutableBlueprint } from "@/lib/services/mutableBlueprint";
import type { QuestionPath } from "@/lib/services/questionPath";

/** Shared prop shape for all contextual editor sections (UI, Logic, Data, Footer). */
export interface QuestionEditorProps {
	question: Question;
	builder: Builder;
}

/** XPath question fields that can be added via "Add Property" buttons. */
export type XPathFieldKey =
	| "validation"
	| "relevant"
	| "default_value"
	| "calculate";

/** Text question fields that can be added via "Add Property" buttons. */
export type TextFieldKey = "hint" | "validation_msg";

/**
 * All field keys that can receive focus after undo/redo.
 * Derived from the `data-field-id` attributes on field wrappers across the
 * contextual editor sections. Used to type `ViewContext.focusHint` and the
 * `useFocusHint` hook so typos are caught at compile time.
 */
export type FocusableFieldKey =
	| XPathFieldKey
	| TextFieldKey
	| "required"
	| "required_condition"
	| "id"
	| "case_property_on"
	| "options";

export const MEDIA_TYPES = new Set(["image", "audio", "video", "signature"]);

export const xpathFields: readonly { field: XPathFieldKey; label: string }[] = [
	{ field: "validation", label: "Validation" },
	{ field: "relevant", label: "Show When" },
	{ field: "default_value", label: "Default Value" },
	{ field: "calculate", label: "Calculate" },
];

export const addableTextFields: readonly {
	field: TextFieldKey;
	label: string;
}[] = [
	{ field: "hint", label: "Hint" },
	{ field: "validation_msg", label: "Validation Message" },
];

/**
 * Tracks a field that was just added via an "Add Property" button. The active
 * field is scoped to the current question path — switching questions clears it
 * automatically. Used by both UI (hint) and Logic (validation_msg, XPath fields)
 * sections to auto-focus newly added fields and handle empty-cancel semantics.
 */
export function useAddableField(questionPath: QuestionPath) {
	const [pending, setPending] = useState<{
		field: string;
		questionPath: QuestionPath;
	}>();

	/** The field key if it belongs to the current question, undefined otherwise. */
	const activeField =
		pending?.questionPath === questionPath ? pending.field : undefined;

	/** Mark a field as newly added — triggers auto-focus and edit activation. */
	const activate = (field: string) => setPending({ field, questionPath });

	/** Clear the pending state — called after save or cancel. */
	const clear = () => setPending(undefined);

	return { activeField, activate, clear } as const;
}

/**
 * Consume the transient focusHint from undo/redo for a specific set of fields.
 * Only clears the hint if it matches one of this component's owned fields —
 * prevents one section from swallowing hints intended for another section.
 * Returns the hint value (valid for one render) or undefined.
 *
 * Single-owner clearing: each section declares its owned fields, and only
 * the matching owner clears the hint. This eliminates the ordering dependency
 * between sibling sections (Data, Logic, UI) rendered by InlineSettingsPanel.
 */
export function useFocusHint(
	builder: Builder,
	ownedFields: ReadonlySet<FocusableFieldKey>,
): FocusableFieldKey | undefined {
	const raw = builder.focusHint;
	const hint =
		raw && ownedFields.has(raw as FocusableFieldKey)
			? (raw as FocusableFieldKey)
			: undefined;
	useEffect(() => {
		if (hint) builder.clearFocusHint();
	}, [hint, builder]);
	return hint;
}

/** Returns case type names this module can write to: its own type + any child types. */
export function getModuleCaseTypes(
	mb: MutableBlueprint,
	moduleIndex: number,
): string[] {
	const mod = mb.getModule(moduleIndex);
	const bp = mb.getBlueprint();
	if (!mod?.case_type || !bp.case_types) return [];
	const result = [mod.case_type];
	for (const ct of bp.case_types) {
		if (ct.parent_type === mod.case_type) result.push(ct.name);
	}
	return result;
}
