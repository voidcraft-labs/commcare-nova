/**
 * validateMsgVisibility — pure rules for the optional `validate_msg`
 * editor that XPathEditor bundles under the special `validate` key.
 *
 * `validate_msg` doesn't have its own registry entry — it lives as a
 * nested property of `validate` because the message text only makes
 * sense after a validation expression exists. The visibility logic
 * answers two related questions:
 *
 *   1. Should the inline message editor mount? — true when the field
 *      already has a saved message, the user just clicked the "Add
 *      Validation Message" pill, or undo/redo focus restoration is
 *      pointing at it.
 *   2. Should the Add Validation Message pill render? — true only when
 *      the message editor is NOT shown AND the parent validate XPath
 *      has a non-empty value (otherwise the message would be noise).
 *
 * Both rules are gated on `keyName === "validate"`; XPathEditor renders
 * for several keys (relevant, validate, default_value, calculate) and
 * only the validate path owns the message UX.
 */

interface ValidateMsgVisibilityArgs {
	/** The key the XPathEditor instance is editing (`validate`, `relevant`, …). */
	keyName: string;
	/** The current XPath value of the parent key (`validate`'s expression). */
	current: string;
	/** True when the field already has a persisted `validate_msg` value. */
	hasValidateMsg: boolean;
	/** Local state — user clicked the Add pill in this session. */
	addingMsg: boolean;
	/** Session focus-hint — undo/redo restored focus to validate_msg. */
	focusHint: string | null | undefined;
}

/**
 * Decide whether the nested message editor should mount. Pure.
 *
 * Returns false unconditionally when the editor isn't on the validate
 * key — every other XPath-valued key skips the message UX entirely.
 */
export function shouldShowValidateMsgEditor(
	args: Omit<ValidateMsgVisibilityArgs, "current">,
): boolean {
	if (args.keyName !== "validate") return false;
	return (
		args.hasValidateMsg || args.addingMsg || args.focusHint === "validate_msg"
	);
}

/**
 * Decide whether the Add Validation Message pill should render. Pure.
 *
 * The pill and the editor are mutually exclusive — only one can occupy
 * the slot beneath the XPath input. The pill is also suppressed when
 * the parent `validate` is empty: a message with no validation rule
 * has nothing to say.
 */
export function shouldShowValidateMsgPill(
	args: ValidateMsgVisibilityArgs,
): boolean {
	if (args.keyName !== "validate") return false;
	if (!args.current) return false;
	return !shouldShowValidateMsgEditor(args);
}
