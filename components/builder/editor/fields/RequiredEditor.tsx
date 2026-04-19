/**
 * RequiredEditor — declarative editor for the `required` field's
 * tri-state lifecycle.
 *
 * The `required` value on a field encodes three states in one string:
 *   - `undefined`  → not required (toggle off)
 *   - `"true()"`   → always required (toggle on, no condition)
 *   - any other XPath → conditionally required (toggle on + condition)
 *
 * This component encapsulates all three transitions — no other code
 * should need to know about the `"true()"` sentinel. It owns the
 * toggle, the add-condition affordance, the nested XPath editor, and
 * save semantics that either clear the property or fall back to the
 * sentinel when a condition is removed.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useContext, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { Toggle } from "@/components/ui/Toggle";
import { buildLintContext } from "@/lib/codemirror/buildLintContext";
import type { XPathLintContext } from "@/lib/codemirror/xpath-lint";
import { BlueprintDocContext } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";

/** CommCare sentinel: "required with no XPath condition" — i.e. always required. */
const ALWAYS_REQUIRED = "true()";

/**
 * Build a lazy lint-context getter for the form that owns the given
 * field. XPathField needs valid-paths + case properties + form entries
 * to lint references; the selected field has a parent chain ending at
 * a form, so walk `fieldParent` until a form entry matches.
 *
 * Returns `undefined` when no provider is mounted or when the walk
 * runs out before hitting a form — callers pass this straight to
 * XPathField which treats the undefined return as "no context".
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

/**
 * Props narrow K to the `required` key. `value` is the raw string
 * or undefined; `onChange(next)` replaces it (undefined removes it).
 *
 * The cast `as F["required" & keyof F]` satisfies the generic key-typed
 * setter even though every kind that carries `required` declares it as
 * `string | undefined`. The registry only wires this component to keys
 * with that exact shape.
 */
export function RequiredEditor<F extends Field>({
	field,
	value,
	onChange,
	label,
	autoFocus,
}: FieldEditorComponentProps<F, "required" & keyof F>) {
	const required = typeof value === "string" ? value : undefined;
	const fieldUuid = field.uuid as Uuid;

	const getLintContext = useFormLintContext(fieldUuid);

	// Local state: whether the user is composing a brand-new condition.
	// Distinct from the XPathField's own edit state — we keep a separate
	// flag so the editor opens blank (rather than resetting to the
	// sentinel) when the user clicks "Condition".
	const [addingCondition, setAddingCondition] = useState(false);

	// Tracks whether the nested XPath editor is active (drives the
	// save-shortcut hint label next to the section heading).
	const [editing, setEditing] = useState(false);

	// Undo/redo focus-hint passthrough: restoring focus to
	// "required_condition" scrolls to and opens the XPath editor;
	// "required" focuses the toggle.
	const focusHint = useSessionFocusHint();
	const shouldFocusToggle = autoFocus || focusHint === "required";
	const shouldOpenCondition = focusHint === "required_condition";

	const hasCondition = !!required && required !== ALWAYS_REQUIRED;
	const isRequired = !!required;

	// ── Save helpers ──────────────────────────────────────────────────
	// Each transition resets local flags explicitly because the editor
	// may unmount in the same React batch, bypassing any internal
	// setState that XPathField's own effect would normally fire.

	const handleToggleOff = useCallback(() => {
		onChange(undefined as F["required" & keyof F]);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const handleToggleOn = useCallback(() => {
		onChange(ALWAYS_REQUIRED as F["required" & keyof F]);
	}, [onChange]);

	const handleConditionSave = useCallback(
		(next: string) => {
			// Empty input reverts to the always-required sentinel rather
			// than clearing the toggle — the user meant "required, but no
			// condition".
			onChange((next || ALWAYS_REQUIRED) as F["required" & keyof F]);
			setAddingCondition(false);
			if (!next) setEditing(false);
		},
		[onChange],
	);

	const handleConditionRemove = useCallback(() => {
		onChange(ALWAYS_REQUIRED as F["required" & keyof F]);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const showEditor =
		isRequired && (hasCondition || addingCondition || shouldOpenCondition);

	return (
		<div data-field-id="required">
			<div className="flex items-center justify-between mb-1">
				{/* Span, not label — Toggle is a custom control (div+button),
				    not a native input, so <label for="..."> would mislead AT. */}
				<span className="text-xs text-nova-text-muted uppercase tracking-wider flex items-center gap-1.5 min-w-0">
					{label}
					{editing && <SaveShortcutHint />}
				</span>
				<Toggle
					enabled={isRequired}
					onToggle={isRequired ? handleToggleOff : handleToggleOn}
					autoFocus={shouldFocusToggle}
					dataFieldId="required"
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
										autoEdit={addingCondition || shouldOpenCondition}
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
