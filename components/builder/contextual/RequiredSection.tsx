/**
 * RequiredSection — self-contained editor for the `required` field's tri-state lifecycle.
 *
 * The `required` field on a question encodes three states in one string:
 *   - `undefined`  → not required (toggle off)
 *   - `"true()"`   → always required (toggle on, no condition)
 *   - any other XPath → conditionally required (toggle on + condition)
 *
 * This component encapsulates all three transitions so no other code needs
 * to know about the `"true()"` sentinel. It owns the toggle, the "Add
 * Condition" button, the XPathField, and the save semantics — calling
 * `useSaveField` directly with the pre-computed value instead of routing
 * through `saveXPath`.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { Toggle } from "@/components/ui/Toggle";
import { useSaveField } from "@/hooks/useSaveField";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import type { Uuid } from "@/lib/doc/types";
import { AddPropertyButton } from "./AddPropertyButton";

/** Sentinel value CommCare uses for "always required" (no condition). */
const ALWAYS_REQUIRED = "true()";

interface RequiredSectionProps {
	/** Current value of the `required` field — truthy means the toggle is on. */
	required: string | undefined;
	/** Field uuid for mutations via `useSaveField`. */
	fieldUuid: Uuid | string | undefined;
	getLintContext: () => XPathLintContext | undefined;
	/** Transient focus hint from undo/redo — when "required", focuses the toggle. */
	focusHint?: string;
	/** Undo/redo scroll + flash target — placed on the toggle so
	 *  the flash highlights only the control, not the label. */
	dataFieldId?: string;
}

/**
 * Full editor for the required field: toggle, optional condition XPath,
 * add/remove condition controls.
 *
 * **State ownership:** This component owns a single piece of local state —
 * whether the user is actively adding a new condition (the XPath editor is
 * open for the first time). Once saved, the condition lives on the question
 * and the "adding" state resets. This avoids sharing addable-field state
 * with other XPath fields in the parent.
 */
export function RequiredSection({
	required,
	fieldUuid,
	getLintContext,
	focusHint,
	dataFieldId,
}: RequiredSectionProps) {
	const saveField = useSaveField(fieldUuid);

	/** True while the user is adding a brand-new condition (editor open, no
	 *  persisted condition yet). Distinct from editing an existing condition,
	 *  which the XPathField manages internally. */
	const [addingCondition, setAddingCondition] = useState(false);

	/** Tracks whether the XPath editor is active (for the save-hint label). */
	const [editing, setEditing] = useState(false);

	const shouldFocusToggle = focusHint === "required";

	const hasCondition = !!required && required !== ALWAYS_REQUIRED;

	// ── Save helpers ────────────────────────────────────────────────────

	/** Toggle required off → removes the field entirely.
	 *  Resets editing because the XPathField unmounts in the same React batch,
	 *  so its onEditingChange(false) effect never fires. */
	const handleToggleOff = useCallback(() => {
		saveField("required", null);
		setAddingCondition(false);
		setEditing(false);
	}, [saveField]);

	/** Toggle required on → sets to "always required" sentinel. */
	const handleToggleOn = useCallback(() => {
		saveField("required", ALWAYS_REQUIRED);
	}, [saveField]);

	/** Save an XPath condition. Empty input reverts to "always required"
	 *  rather than removing the field — the toggle stays on.
	 *  Empty saves unmount the XPathField (showEditor becomes false) in the same
	 *  React batch as setEditing(false) inside XPathField, so its onEditingChange
	 *  effect never fires — reset explicitly here. */
	const handleConditionSave = useCallback(
		(value: string) => {
			saveField("required", value || ALWAYS_REQUIRED);
			setAddingCondition(false);
			if (!value) setEditing(false);
		},
		[saveField],
	);

	/** Remove the condition but keep the toggle on.
	 *  Same batching issue as handleConditionSave — reset editing explicitly. */
	const handleConditionRemove = useCallback(() => {
		saveField("required", ALWAYS_REQUIRED);
		setAddingCondition(false);
		setEditing(false);
	}, [saveField]);

	// ── Always render toggle so it stays in the DOM across undo/redo ────
	// CSS transitions animate the flip naturally when `enabled` changes.

	const isRequired = !!required;

	const showEditor =
		isRequired &&
		(hasCondition || addingCondition || focusHint === "required_condition");

	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				{/* Visual heading — Toggle is a custom component, not a native input */}
				<span className="text-xs text-nova-text-muted uppercase tracking-wider flex items-center gap-1.5 min-w-0">
					Required
					{editing && <SaveShortcutHint />}
				</span>
				<Toggle
					enabled={isRequired}
					onToggle={isRequired ? handleToggleOff : handleToggleOn}
					autoFocus={shouldFocusToggle}
					dataFieldId={dataFieldId}
				/>
			</div>
			<AnimatePresence initial={false}>
				{isRequired && (
					<motion.div
						key="required-content"
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.15, ease: "easeOut" }}
						className="overflow-hidden"
					>
						{showEditor ? (
							<div
								className="flex items-center gap-1.5 group/condition"
								data-field-id="required_condition"
							>
								<div className="flex-1 min-w-0">
									<XPathField
										value={hasCondition ? required : ""}
										onSave={handleConditionSave}
										getLintContext={getLintContext}
										autoEdit={
											addingCondition || focusHint === "required_condition"
										}
										onEditingChange={setEditing}
									/>
								</div>
								{hasCondition && (
									<button
										type="button"
										onClick={handleConditionRemove}
										aria-label="Remove condition"
										className="shrink-0 p-0.5 text-nova-text-muted opacity-0 group-hover/condition:opacity-100 hover:text-nova-rose transition-all cursor-pointer"
										tabIndex={-1}
									>
										<Icon icon={tablerTrash} width="12" height="12" />
									</button>
								)}
							</div>
						) : (
							<AddPropertyButton
								label="Condition"
								onClick={() => setAddingCondition(true)}
							/>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
