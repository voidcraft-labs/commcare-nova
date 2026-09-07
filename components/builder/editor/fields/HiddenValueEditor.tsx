/**
 * HiddenValueEditor: the one Value control of a hidden field.
 *
 * A hidden field's value comes from exactly one of two slots, `calculate`
 * (keep in step) or `default_value` (set once), and the rail presents them
 * as one control with a mode switch rather than two editors, because the
 * question a person is answering is "how is this value set", not "which
 * slot do I fill". Every gesture dispatches ONE `updateField` naming both
 * slots (`hiddenValueModel.ts` builds the patches), so a save, a mode
 * switch, or a clear is one undo entry and one gate evaluation, and the
 * document can never hold both slots at once.
 *
 * Keep in step always holds an authored calculation, never the inert
 * placeholder (see the model's header for why). So choosing it with nothing
 * to carry is a local state, not a write: the control shows Keep in step
 * with the editor open and commits only the calculation someone types;
 * closing the editor empty leaves the field as it was. A hidden field that
 * holds only the placeholder (a fresh insertion, a conversion that carried
 * nothing) shows Keep in step at rest for the same reason, because most
 * hidden values track other answers, so the person types straight into the
 * mode they most likely want while the document holds the harmless set-once
 * placeholder until they do. The one exception is a preloaded writer, where
 * set once is a real fact worth showing.
 *
 * On a one-case followup form where the field writes the loaded case's own
 * type, set once shows the preloaded-value row instead of an editor: the
 * case supplies the value, and a typed expression there would never run.
 * The mode stays selectable because on such a writer set once has a real
 * meaning (carry the case's value through unchanged).
 *
 * `data-field-id` conventions: the mode switch is `value_mode`; the body is
 * the SHOWN slot key, so undo focus, `findFieldElement`, and Playwright
 * address whichever slot currently holds (or is about to hold) the value.
 *
 * Mounted through `fieldEditorSchemas` on the `calculate` entry with the
 * CodeMirror chunk, never synchronously.
 */
"use client";

import { useCallback, useState } from "react";
import { useFormLintContext } from "@/components/builder/editor/fields/useFormLintContext";
import { InfoPopover } from "@/components/builder/InfoPopover";
import {
	INSPECTOR_LABEL_CLS,
	InspectorHint,
	SegmentedRow,
} from "@/components/builder/inspector/inspectorChrome";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { SaveShortcutHint } from "@/components/builder/SaveShortcutHint";
import { XPathField } from "@/components/builder/XPathField";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useParseXPathForField,
	useXPathProjection,
} from "@/lib/doc/hooks/useXPathSlots";
import {
	type CommitOutcome,
	type HiddenField,
	writerPreloadsInContext,
} from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import { useSessionFocusHint } from "@/lib/session/hooks";
import {
	activeHiddenValueMode,
	HIDDEN_VALUE_EMPTY_PATCH,
	HIDDEN_VALUE_MODES,
	type HiddenValueMode,
	type HiddenValuePatch,
	hiddenValueModeHint,
	hiddenValueModeSwitch,
	hiddenValueSavePatch,
	isInertHiddenValue,
} from "./hiddenValueModel";
import { PreloadedValueRow } from "./PreloadedValueRow";

const PROJECTION_FAILED =
	"This expression contains a reference that no longer resolves. Re-enter the intended field or worker-information reference.";

export function HiddenValueEditor({
	field,
	label,
	autoFocus,
}: FieldEditorComponentProps<HiddenField, "calculate">) {
	const storedMode = activeHiddenValueMode(field);
	const preloads = writerPreloadsInContext(field, useSelectedFormContext());
	/* Whether the control shows keep in step over a set-once document. An
	 * explicit choice is remembered per field (the instance is reused across
	 * selections) and opens the editor; with no choice made, a field holding
	 * only the inert placeholder shows keep in step at rest, except a
	 * preloaded writer, where set once is the truth worth showing (the
	 * case's value carries through). */
	const [awaitingChoice, setAwaitingChoice] = useState<{
		readonly uuid: string;
		readonly awaiting: boolean;
	} | null>(null);
	const chosen =
		awaitingChoice?.uuid === field.uuid ? awaitingChoice.awaiting : undefined;
	const awaitingCalculation =
		storedMode === "default_value" &&
		(chosen ?? (isInertHiddenValue(field.default_value) && !preloads));
	const mode: HiddenValueMode = awaitingCalculation ? "calculate" : storedMode;
	const expression = mode === storedMode ? field[storedMode] : undefined;
	const projection = useXPathProjection(expression);
	const parseForField = useParseXPathForField(field.uuid);
	const getLintContext = useFormLintContext(field.uuid);
	const focusHint = useSessionFocusHint();
	const {
		inline: { updateField },
	} = useBlueprintMutations();
	const [editing, setEditing] = useState(false);
	const [rejection, setRejection] = useState<string | null>(null);

	const dispatch = useCallback(
		(patch: HiddenValuePatch): CommitOutcome => {
			const outcome = updateField(field.uuid, "hidden", patch);
			setRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome;
		},
		[updateField, field.uuid],
	);
	const handleSave = useCallback(
		(next: string): CommitOutcome | undefined => {
			if (next === "") {
				/* Nothing typed while awaiting a calculation: the field is
				 * already set once with nothing, so there is nothing to write. */
				if (awaitingCalculation) return undefined;
				return dispatch(hiddenValueSavePatch(mode, undefined));
			}
			return dispatch(hiddenValueSavePatch(mode, parseForField(next)));
		},
		[dispatch, mode, awaitingCalculation, parseForField],
	);
	const handleEditingChange = useCallback(
		(next: boolean) => {
			setEditing(next);
			/* The editor a chosen keep in step opened has closed, by a save or
			 * an Escape. A saved calculation has already moved the stored
			 * mode; an abandoned one falls back to the resting rule. */
			if (!next) {
				setAwaitingChoice((prev) =>
					prev?.uuid === field.uuid && prev.awaiting ? null : prev,
				);
			}
		},
		[field.uuid],
	);
	const switchMode = useCallback(
		(next: HiddenValueMode) => {
			const verdict = hiddenValueModeSwitch(field, next);
			if (verdict.kind === "commit") {
				dispatch(verdict.patch);
				setAwaitingChoice(null);
			} else {
				/* Toward keep in step with nothing to carry: open the editor.
				 * Toward set once on a field already stored that way: the
				 * resting rule was showing keep in step, so remember the
				 * person's answer. */
				setAwaitingChoice({
					uuid: field.uuid,
					awaiting: verdict.kind === "await-calculation",
				});
			}
		},
		[dispatch, field],
	);

	/* The inert placeholder a builder-born field carries is not an authored
	 * expression, so the preloaded row treats it as nothing stored. */
	const showsPreloadedRow = mode === "default_value" && preloads;
	const stored =
		showsPreloadedRow &&
		expression !== undefined &&
		!isInertHiddenValue(expression)
			? projection
			: undefined;

	return (
		<div className="space-y-2">
			<span
				className={`${INSPECTOR_LABEL_CLS} flex min-h-11 items-center gap-1.5`}
			>
				{label}
				{editing && <SaveShortcutHint />}
				<InfoPopover
					title="How the value is set"
					ariaLabel="How the value is set"
				>
					Keep in step recalculates the value whenever a value it uses changes
					and every time the form opens, including a saved form someone resumes.
					Set once runs when the form first opens and never again.
				</InfoPopover>
			</span>
			<div data-field-id="value_mode">
				<SegmentedRow
					legend="How the value is set"
					options={HIDDEN_VALUE_MODES}
					value={mode}
					onChange={switchMode}
				/>
			</div>
			<InspectorHint>{hiddenValueModeHint(mode, preloads)}</InspectorHint>
			{showsPreloadedRow ? (
				<PreloadedValueRow
					keyName="default_value"
					stored={stored}
					onRemoveStored={() => dispatch(HIDDEN_VALUE_EMPTY_PATCH)}
				/>
			) : (
				<div data-field-id={mode}>
					{/* `autoEdit` is read at mount, so the key carries both the
					 * slot and a chosen keep in step: choosing it over the resting
					 * editor remounts into editing. */}
					<XPathField
						key={chosen === true ? `${mode}:chosen` : mode}
						value={projection.text}
						onSave={handleSave}
						getLintContext={getLintContext}
						autoEdit={!!autoFocus || focusHint === mode || chosen === true}
						onEditingChange={handleEditingChange}
					/>
				</div>
			)}
			{!projection.ok && !showsPreloadedRow && (
				<RejectionInline message={PROJECTION_FAILED} />
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}
