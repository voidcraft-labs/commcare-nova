/**
 * XPathEditor — generic editor for any XPath-valued field key.
 *
 * Used for: `relevant`, `validate`, `default_value`, `calculate`.
 * Wraps XPathField with a section label, the save-shortcut hint, and
 * lint-context wiring.
 *
 * Special case: when `keyName === "validate"` this editor also owns
 * the optional `validate_msg` text field beneath the XPath editor.
 * The validation message is conceptually a child of `validate` (the
 * text a user sees when the expression fails), not a sibling Logic
 * entry, so the editor bundles both rather than giving `validate_msg`
 * its own registry row. No kind's editor schema contains a
 * `validate_msg` entry — its UX is owned entirely at this boundary.
 */

"use client";
import { useCallback, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { useFormLintContext } from "@/components/builder/editor/fields/useFormLintContext";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Field, FieldPatch } from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	XPathStringKeys,
} from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";
import {
	shouldShowValidateMsgEditor,
	shouldShowValidateMsgPill,
} from "./validateMsgVisibility";

/**
 * `K extends XPathStringKeys<F>` admits both optional (`string |
 * undefined`) and required (`string`) XPath-valued keys. Only one
 * kind carries a required XPath key at the time of writing —
 * `hidden.calculate` — and the reducer tolerates a removal patch on
 * it the same way as on an optional key, so this editor treats both
 * shapes uniformly. The `as F[K]` casts that pass through `undefined`
 * lie at the type level for required keys; the caller-side registry
 * invariant (every value is a string or undefined, the reducer
 * accepts both) is the authoritative guarantee.
 */
export function XPathEditor<F extends Field, K extends XPathStringKeys<F>>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { field, value, onChange, label, autoFocus, keyName } = props;
	const current = typeof value === "string" ? value : "";

	// `field.uuid` is already branded `Uuid` by the Field type.
	const getLintContext = useFormLintContext(field.uuid);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);

	const handleSave = useCallback(
		(next: string) => {
			onChange((next === "" ? undefined : next) as F[K]);
		},
		[onChange],
	);

	// `validate_msg` is a nested property owned by the validate editor
	// rather than a sibling registry entry. The `in` narrowing is
	// necessary because several kinds omit the key entirely.
	const isValidate = keyName === "validate";
	const validateMsg =
		isValidate && "validate_msg" in field
			? (field.validate_msg as string | undefined)
			: undefined;
	const hasValidateMsg = !!validateMsg;
	const [addingMsg, setAddingMsg] = useState(false);

	// Visibility decisions live in `validateMsgVisibility.ts` so the
	// "show editor vs pill vs nothing" rules are pinned in pure tests
	// without mounting the XPath editor's CodeMirror surface.
	const showValidateMsgEditor = shouldShowValidateMsgEditor({
		keyName,
		hasValidateMsg,
		addingMsg,
		focusHint,
	});
	const showValidateMsgPill = shouldShowValidateMsgPill({
		keyName,
		current,
		hasValidateMsg,
		addingMsg,
		focusHint,
	});

	// `validate_msg` doesn't flow through the generic `onChange` (that
	// prop is scoped to `keyName`). Dispatch via the doc-mutation API
	// directly so the message writes to the same field entity.
	const { updateField } = useBlueprintMutations();
	const saveValidateMsg = useCallback(
		(next: string) => {
			updateField(field.uuid, {
				validate_msg: next === "" ? undefined : next,
			} as FieldPatch);
			setAddingMsg(false);
		},
		[updateField, field.uuid],
	);

	// Empty commit clears the message through the same patch path.
	// Cancelling a brand-new add also drops the pending flag so the
	// Add pill reappears.
	const clearValidateMsg = useCallback(() => {
		updateField(field.uuid, {
			validate_msg: undefined,
		} as FieldPatch);
		setAddingMsg(false);
	}, [updateField, field.uuid]);

	return (
		<div>
			<span className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
				{label}
				{editing && <SaveShortcutHint />}
			</span>
			<div data-field-id={keyName}>
				<XPathField
					value={current}
					onSave={handleSave}
					getLintContext={getLintContext}
					autoEdit={!!autoFocus || focusHint === keyName}
					onEditingChange={setEditing}
				/>
			</div>
			{showValidateMsgEditor && (
				<div className="mt-1">
					<EditableText
						label="Validation Message"
						dataFieldId="validate_msg"
						value={validateMsg ?? ""}
						onSave={saveValidateMsg}
						onEmpty={clearValidateMsg}
						autoFocus={addingMsg || focusHint === "validate_msg"}
					/>
				</div>
			)}
			{showValidateMsgPill && (
				<div className="mt-1">
					<AddPropertyButton
						label="Validation Message"
						onClick={() => setAddingMsg(true)}
					/>
				</div>
			)}
		</div>
	);
}
