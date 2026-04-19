/**
 * XPathEditor — generic editor for any XPath-valued field key.
 *
 * Used for: `relevant`, `validate`, `default_value`, `calculate`.
 * Wraps XPathField with a section label, the save-shortcut hint, and
 * lint-context wiring.
 *
 * Special case: when keyName === "validate", this editor also owns the
 * optional `validate_msg` text field beneath the XPath editor. The
 * validation message is conceptually a child of validate (the text a
 * user sees when the expression fails), not a sibling Logic entry, so
 * it's bundled here rather than given its own registry row. There is
 * deliberately no `validate_msg` entry in any kind's editor schema —
 * its UX is owned at this boundary.
 */

"use client";
import { useCallback, useContext, useState } from "react";
import { EditableText } from "@/components/builder/EditableText";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { Field, FieldPatch } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";

/**
 * Lazy getter for the XPath lint context rooted at the field's owning
 * form. Walks `fieldParent` up until a form entity matches. Returns
 * undefined when no provider is mounted or no form is found — callers
 * pass this straight to XPathField which treats undefined as "no
 * context" rather than throwing.
 */
function useFormLintContext(
	fieldUuid: Uuid,
): () => XPathLintContext | undefined {
	const docStore = useContext(BlueprintDocContext);
	return useCallback(() => {
		if (!docStore) return undefined;
		const s = docStore.getState();
		let parentUuid: Uuid | undefined = s.fieldParent[fieldUuid] ?? undefined;
		while (parentUuid && !s.forms[parentUuid]) {
			parentUuid = s.fieldParent[parentUuid] ?? undefined;
		}
		if (!parentUuid) return undefined;
		return buildLintContext(s, parentUuid);
	}, [docStore, fieldUuid]);
}

export function XPathEditor<F extends Field, K extends keyof F & string>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { field, value, onChange, label, autoFocus, keyName } = props;
	const fieldUuid = field.uuid as Uuid;
	const current = typeof value === "string" ? value : "";

	const getLintContext = useFormLintContext(fieldUuid);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);

	// Empty commit clears the property via `undefined`. The cast is the
	// generic-key-typed form of "the registry guarantees string keys
	// here"; non-string keys never land on this component.
	const handleSave = useCallback(
		(next: string) => {
			onChange((next === "" ? undefined : next) as F[K]);
		},
		[onChange],
	);

	// validate_msg is a nested property owned by the validate editor
	// rather than a sibling registry entry. Reading it requires the
	// `in` narrowing because several kinds omit it entirely.
	const isValidate = keyName === "validate";
	const validateMsg =
		isValidate && "validate_msg" in field
			? (field.validate_msg as string | undefined)
			: undefined;
	const hasValidateMsg = !!validateMsg;
	const [addingMsg, setAddingMsg] = useState(false);

	// Show the nested message editor when the user opts in (pill click),
	// when undo/redo is restoring focus to it, or when a value is
	// already persisted.
	const showValidateMsg =
		isValidate && (hasValidateMsg || addingMsg || focusHint === "validate_msg");

	// validate_msg doesn't come through the generic onChange prop (that
	// prop is scoped to keyName). Use the doc-mutation API directly.
	const { updateField } = useBlueprintMutations();
	const saveValidateMsg = useCallback(
		(next: string) => {
			updateField(asUuid(fieldUuid), {
				validate_msg: next === "" ? undefined : next,
			} as FieldPatch);
			setAddingMsg(false);
		},
		[updateField, fieldUuid],
	);

	// Empty commit on the message input clears it via the same patch
	// path. Cancelling a brand-new add also drops the pending flag so
	// the Add pill reappears.
	const clearValidateMsg = useCallback(() => {
		updateField(asUuid(fieldUuid), {
			validate_msg: undefined,
		} as FieldPatch);
		setAddingMsg(false);
	}, [updateField, fieldUuid]);

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
