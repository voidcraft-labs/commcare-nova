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
	OptionalStringKeys,
} from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";

/**
 * `K extends OptionalStringKeys<F>` pins the key to one whose declared
 * type is exactly `string | undefined`. That makes every value written
 * through `onChange` a value-level subtype of `F[K]`; the `as F[K]`
 * casts in the handlers are tautologies that TypeScript requires only
 * because `F[K]` is an indexed access through a generic.
 */
export function XPathEditor<F extends Field, K extends OptionalStringKeys<F>>(
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

	// Show the nested message editor when the user opts in (pill
	// click), when undo/redo restores focus to it, or when a value
	// is already persisted.
	const showValidateMsg =
		isValidate && (hasValidateMsg || addingMsg || focusHint === "validate_msg");

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
			{isValidate &&
				(showValidateMsg ? (
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
				) : (
					// Only offer the add affordance when the parent XPath has
					// a value — a message with no validation is noise.
					current && (
						<div className="mt-1">
							<AddPropertyButton
								label="Validation Message"
								onClick={() => setAddingMsg(true)}
							/>
						</div>
					)
				))}
		</div>
	);
}
