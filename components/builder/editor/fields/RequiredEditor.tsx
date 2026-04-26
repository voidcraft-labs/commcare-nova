/**
 * RequiredEditor — declarative editor for the `required` field's
 * tri-state lifecycle.
 *
 * The `required` value encodes three states in one string:
 *   - `undefined`   → not required (toggle off)
 *   - `"true()"`    → always required (toggle on, no condition)
 *   - any other XPath → conditionally required (toggle on + condition)
 *
 * This component owns the toggle, the add-condition affordance, the
 * nested XPath editor, and the save semantics for every transition —
 * no other code needs to know about the `"true()"` sentinel. Removing
 * a condition falls back to the sentinel (keeps the toggle on); the
 * toggle-off path clears the property entirely.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerTrash from "@iconify-icons/tabler/trash";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";
import { AddPropertyButton } from "@/components/builder/editor/AddPropertyButton";
import { useFormLintContext } from "@/components/builder/editor/fields/useFormLintContext";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { Toggle } from "@/components/ui/Toggle";
import type { Field } from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSessionFocusHint } from "@/lib/session/hooks";
import {
	deriveRequiredState,
	nextRequiredValue,
	shouldShowConditionEditor,
} from "./requiredState";

/**
 * Props narrow `K` to the `required` key. `value` is the raw string
 * or `undefined`; `onChange(next)` replaces it (undefined removes it).
 *
 * The `as F["required" & keyof F]` casts let the sentinel string and
 * `undefined` flow through the generic-key-typed `onChange`. Every
 * kind that declares `required` carries it as `string | undefined`,
 * so the values are always valid — the cast is the syntactic form
 * TS requires when writing through an indexed-access generic.
 */
export function RequiredEditor<F extends Field>({
	field,
	value,
	onChange,
	label,
	autoFocus,
}: FieldEditorComponentProps<F, "required" & keyof F>) {
	const required = typeof value === "string" ? value : undefined;
	const { enabled, hasCondition, conditionValue } =
		deriveRequiredState(required);

	// `field.uuid` is already branded `Uuid` by the Field type — no
	// second cast is needed before calling into the doc-store hook.
	const getLintContext = useFormLintContext(field.uuid);

	// Local state: whether the user is composing a brand-new condition.
	// Distinct from the XPathField's own edit state — the flag lets the
	// editor open blank (rather than resetting to the sentinel) when
	// the user clicks "Condition".
	const [addingCondition, setAddingCondition] = useState(false);

	// Tracks whether the nested XPath editor is active (drives the
	// save-shortcut hint label next to the section heading).
	const [editing, setEditing] = useState(false);

	// Undo/redo focus-hint passthrough: restoring focus to
	// `required_condition` scrolls to and opens the XPath editor;
	// `required` focuses the toggle.
	const focusHint = useSessionFocusHint();
	const shouldFocusToggle = autoFocus || focusHint === "required";
	const shouldOpenCondition = focusHint === "required_condition";

	// ── Save helpers ──────────────────────────────────────────────────
	// Each transition resets local flags explicitly because the editor
	// may unmount in the same React batch, bypassing any internal
	// setState that XPathField's own effect would normally fire. The
	// next-value computation is owned by `nextRequiredValue` so the
	// sentinel-vs-undefined logic stays in one tested place.

	const handleToggleOff = useCallback(() => {
		onChange(
			nextRequiredValue({ type: "toggle-off" }) as F["required" & keyof F],
		);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const handleToggleOn = useCallback(() => {
		onChange(
			nextRequiredValue({ type: "toggle-on" }) as F["required" & keyof F],
		);
	}, [onChange]);

	const handleConditionSave = useCallback(
		(next: string) => {
			onChange(
				nextRequiredValue({
					type: "save-condition",
					next,
				}) as F["required" & keyof F],
			);
			setAddingCondition(false);
			if (!next) setEditing(false);
		},
		[onChange],
	);

	const handleConditionRemove = useCallback(() => {
		onChange(
			nextRequiredValue({
				type: "remove-condition",
			}) as F["required" & keyof F],
		);
		setAddingCondition(false);
		setEditing(false);
	}, [onChange]);

	const showEditor = shouldShowConditionEditor({
		enabled,
		hasCondition,
		addingCondition,
		shouldOpenCondition,
	});

	// `data-field-id` is hardcoded to `"required"` because this editor
	// is permanently bound to that key — the registry only wires it
	// onto `required`, and undo/redo focus hints reference the same
	// string literal by contract.
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
					enabled={enabled}
					onToggle={enabled ? handleToggleOff : handleToggleOn}
					autoFocus={shouldFocusToggle}
					dataFieldId="required"
				/>
			</div>
			<AnimatePresence initial={false}>
				{enabled && (
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
										value={conditionValue}
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
