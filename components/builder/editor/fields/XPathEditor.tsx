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
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { useFormLintContext } from "@/components/builder/editor/fields/useFormLintContext";
import { INSPECTOR_LABEL_CLS } from "@/components/builder/inspector/inspectorChrome";
import { RefLabelInput } from "@/components/builder/RefLabelInput";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useParseXPathForField,
	useXPathProjection,
} from "@/lib/doc/hooks/useXPathSlots";
import type {
	Field,
	FieldPatchFor,
	ProseTemplate,
	XPathExpression,
} from "@/lib/domain";
import type {
	FieldEditorComponentProps,
	XPathExpressionKeys,
} from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";
import {
	shouldShowValidateMsgEditor,
	shouldShowValidateMsgPill,
} from "./validateMsgVisibility";

/**
 * The slot's stored form is the expression AST; this editor's surface
 * stays TEXT. Display prints the stored value against the live doc
 * (a rename of a referenced field updates the shown text with no slot
 * write); commit parses the authored text back. The `as F[K]` casts
 * widen through the generic — the editor only mounts on
 * `XPathExpressionKeys`, so the runtime value is always an expression
 * or undefined.
 */
export function XPathEditor<F extends Field, K extends XPathExpressionKeys<F>>(
	props: FieldEditorComponentProps<F, K>,
) {
	const { field, value, onChange, label, autoFocus, keyName } = props;
	const projection = useXPathProjection(value as XPathExpression | undefined);
	const current = projection.text;
	const parseForField = useParseXPathForField(field.uuid);

	// `field.uuid` is already branded `Uuid` by the Field type.
	const getLintContext = useFormLintContext(field.uuid);
	const focusHint = useSessionFocusHint();
	const [editing, setEditing] = useState(false);

	const handleSave = useCallback(
		(next: string) => {
			// Forward the gated outcome — XPathField keeps the editor open
			// with the draft + an inline message when the gate refuses (e.g.
			// a dependency cycle only the whole-doc validator can see).
			return onChange((next === "" ? undefined : parseForField(next)) as F[K]);
		},
		[onChange, parseForField],
	);

	// `validate_msg` is a nested property owned by the validate editor
	// rather than a sibling registry entry. The `in` narrowing is
	// necessary because several kinds omit the key entirely.
	const isValidate = keyName === "validate";
	const validateMsg =
		isValidate && "validate_msg" in field
			? (field.validate_msg as ProseTemplate | undefined)
			: undefined;
	const hasValidateMsg = !!validateMsg;
	const [addingMsg, setAddingMsg] = useState(false);
	const [validateMsgRejection, setValidateMsgRejection] = useState<
		string | null
	>(null);

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
	// directly so the message writes to the same field entity. The
	// editor only mounts when `keyName === "validate"`, which is true
	// exclusively on kinds whose schema declares `validate_msg`. The
	// `as` cast widens the literal-key patch back to the kind's partial
	// shape — TS can't prove `validate_msg` belongs on `F` from inside
	// this generic body.
	/* Inline flavor: the validate-message editor renders the returned
	 * outcome itself (EditableText's notice), and the clear arm removes a
	 * message string — a removal no validator rule can object to. */
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const saveValidateMsg = useCallback(
		(next: ProseTemplate) => {
			const outcome = updateField(field.uuid, field.kind, {
				validate_msg: next,
			} as unknown as FieldPatchFor<F["kind"]>);
			if (outcome.ok) {
				setAddingMsg(false);
				setValidateMsgRejection(null);
			} else {
				setValidateMsgRejection(outcome.messages.join(" "));
			}
		},
		[updateField, field.uuid, field.kind],
	);

	// Empty commit on the validation-message editor. Two arms with
	// different conditionality:
	//   - Slot clear is gated on `validate_msg !== undefined`. A
	//     focus-blur-without-typing or Esc-on-empty gesture on a
	//     never-set message slot has nothing to clear; firing the
	//     removal patch unconditionally would stamp an undo-history
	//     entry for a passive interaction the user never asked for.
	//   - Add-pill state reset (`setAddingMsg(false)`) fires
	//     unconditionally. The user backing out of "Add Validation
	//     Message" must always close the editor and bring the pill
	//     back, regardless of whether the slot had a value to clear.
	const clearValidateMsg = useCallback(() => {
		if (validateMsg !== undefined) {
			const outcome = updateField(field.uuid, field.kind, {
				validate_msg: null,
			} as unknown as FieldPatchFor<F["kind"]>);
			setValidateMsgRejection(outcome.ok ? null : outcome.messages.join(" "));
		}
		setAddingMsg(false);
	}, [updateField, field.uuid, field.kind, validateMsg]);

	return (
		<div>
			<span
				className={`${INSPECTOR_LABEL_CLS} mb-1.5 flex items-center gap-1.5`}
			>
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
			{!projection.ok && (
				<RejectionInline message="This expression contains a reference that no longer resolves. Re-enter the intended field or worker-information reference." />
			)}
			{showValidateMsgEditor && (
				<div className="mt-1">
					<RefLabelInput
						label="Validation message"
						dataFieldId="validate_msg"
						value={validateMsg ?? { parts: [] }}
						onSave={saveValidateMsg}
						onEmpty={clearValidateMsg}
						autoFocus={addingMsg || focusHint === "validate_msg"}
					/>
					{validateMsgRejection && (
						<RejectionInline message={validateMsgRejection} />
					)}
				</div>
			)}
			{showValidateMsgPill && (
				<div className="mt-1">
					<AddPropertyButton
						label="Validation message"
						onClick={() => setAddingMsg(true)}
					/>
				</div>
			)}
		</div>
	);
}
