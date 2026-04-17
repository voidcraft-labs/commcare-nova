import { useEffect, useState } from "react";
import type { CaseType, Field, FieldKind } from "@/lib/domain";
import { useClearFocusHint, useSessionFocusHint } from "@/lib/session/hooks";

/** Shared prop shape for all contextual editor sections (UI, Logic, Data, Footer).
 *  Only the field data — store access is via hooks, not props. */
export interface QuestionEditorProps {
	question: Field;
}

/** XPath field keys that can be added via "Add Property" buttons.
 *
 * The names match the domain `Field` schema: `validate` (not the legacy
 * wire `validation`), `relevant`, `default_value`, `calculate`. The data
 * attributes (`data-field-id`) still carry the same strings so the
 * undo/redo focus-hint layer stays stable across the rename.
 */
export type XPathFieldKey =
	| "validate"
	| "relevant"
	| "default_value"
	| "calculate";

/** Text field keys that can be added via "Add Property" buttons. */
export type TextFieldKey = "hint" | "validate_msg";

/**
 * All field keys that can receive focus after undo/redo.
 * Derived from the `data-field-id` attributes on field wrappers across the
 * contextual editor sections. Used to type `ViewContext.activeFieldId` and the
 * `useFocusHint` hook so typos are caught at compile time.
 *
 * `case_property_on` is retained as a focus-hint key (not `case_property`)
 * because the attribute predates the domain rename and a rename would
 * invalidate any in-flight focus hints in the URL/undo stack.
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

// ── Per-type field support ──────────────────────────────────────────────
// CommCare/Formplayer constraints on which logic properties are meaningful
// per question type. Verified against CommCare HQ xform.py bind handling,
// Formplayer FormEntryController (validation only runs on input questions),
// and JavaRosa Recalculate.apply() (calculate overwrites user input).

/* FieldKind is the domain replacement for the legacy wire `Question["type"]`
 * discriminant. The same string values (text, int, decimal, etc.) flow
 * through — only the import source + shape change. */

/** User-input kinds where `required` is enforced by Formplayer. Excludes
 *  hidden (no interaction), label (display-only), group/repeat (containers —
 *  Formplayer ignores required on groups). */
const TYPES_WITH_REQUIRED = new Set<FieldKind>([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"image",
	"audio",
	"video",
	"signature",
	"barcode",
	"secret",
]);

/** Types with XPath-expressible values that can be meaningfully constrained.
 *  Excludes media types (binary data — nothing to validate in XPath),
 *  hidden (user can't see or fix validation errors), and containers/labels. */
const TYPES_WITH_VALIDATION = new Set<FieldKind>([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"geopoint",
	"barcode",
	"secret",
]);

/** Calculate overwrites user input on every dependency change (confirmed in
 *  Formplayer's Recalculate.apply()). Only hidden fields should have
 *  calculate — they exist primarily to hold computed values. */
const TYPES_WITH_CALCULATE = new Set<FieldKind>(["hidden"]);

/** Types where a starting value is meaningful. Not geopoint (can't default
 *  GPS coordinates), not barcode (can't default a scan), not media (binary),
 *  not label/group/repeat (no data node). */
const TYPES_WITH_DEFAULT = new Set<FieldKind>([
	"text",
	"int",
	"decimal",
	"date",
	"time",
	"datetime",
	"single_select",
	"multi_select",
	"hidden",
	"secret",
]);

/** Fields that have per-type restrictions. `relevant` is intentionally absent
 *  — it's universal across all types, so lookup returns undefined → allowed. */
type FilteredFieldKey = XPathFieldKey | "required" | "hint";

const FIELD_TYPE_SUPPORT: Partial<
	Record<FilteredFieldKey, ReadonlySet<FieldKind>>
> = {
	required: TYPES_WITH_REQUIRED,
	validate: TYPES_WITH_VALIDATION,
	calculate: TYPES_WITH_CALCULATE,
	default_value: TYPES_WITH_DEFAULT,
	hint: TYPES_WITH_REQUIRED, // Same set — hint applies to all user-input types
};

/** Whether a logic field is supported for a given question type. Returns true
 *  for `relevant` (universal) and any field not in the support map (safe default). */
export function fieldSupportedForType(
	field: FilteredFieldKey,
	type: FieldKind,
): boolean {
	const supported = FIELD_TYPE_SUPPORT[field];
	return !supported || supported.has(type);
}

export const xpathFields: readonly { field: XPathFieldKey; label: string }[] = [
	{ field: "validate", label: "Validation" },
	{ field: "relevant", label: "Show When" },
	{ field: "default_value", label: "Default Value" },
	{ field: "calculate", label: "Calculate" },
];

export const addableTextFields: readonly {
	field: TextFieldKey;
	label: string;
}[] = [
	{ field: "hint", label: "Hint" },
	{ field: "validate_msg", label: "Validation Message" },
];

/**
 * Tracks a field that was just added via an "Add Property" button. The active
 * field is scoped to a question identity key (uuid) — switching questions
 * clears it automatically. Used by both UI (hint) and Logic (validation_msg,
 * XPath fields) sections to auto-focus newly added fields and handle
 * empty-cancel semantics.
 */
export function useAddableField(questionKey: string) {
	const [pending, setPending] = useState<{
		field: string;
		key: string;
	}>();

	/** The field key if it belongs to the current question, undefined otherwise. */
	const activeField = pending?.key === questionKey ? pending.field : undefined;

	/** Mark a field as newly added — triggers auto-focus and edit activation. */
	const activate = (field: string) => setPending({ field, key: questionKey });

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
	ownedFields: ReadonlySet<FocusableFieldKey>,
): FocusableFieldKey | undefined {
	const raw = useSessionFocusHint();
	const clearFocusHint = useClearFocusHint();
	const hint =
		raw && ownedFields.has(raw as FocusableFieldKey)
			? (raw as FocusableFieldKey)
			: undefined;
	useEffect(() => {
		if (hint) clearFocusHint();
	}, [hint, clearFocusHint]);
	return hint;
}

/** Returns case type names this module can write to: its own type + any child types. */
export function getModuleCaseTypes(
	caseType: string | undefined,
	caseTypes: CaseType[],
): string[] {
	if (!caseType) return [];
	const result = [caseType];
	for (const ct of caseTypes) {
		if (ct.parent_type === caseType) result.push(ct.name);
	}
	return result;
}
