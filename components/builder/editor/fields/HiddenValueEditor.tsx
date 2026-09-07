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
 * On a one-case followup form where the field writes the loaded case's own
 * type, set once shows the preloaded-value row instead of an editor: the
 * case supplies the value, and a typed expression there would never run.
 * The mode stays selectable because on such a writer set once has a real
 * meaning (carry the case's value through unchanged).
 *
 * `data-field-id` conventions: the mode switch is `value_mode`; the body is
 * the ACTIVE slot key, so undo focus, `findFieldElement`, and Playwright
 * address whichever slot currently holds the value.
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
	writerPreloadsFromLoadedCase,
} from "@/lib/domain";
import type { FieldEditorComponentProps } from "@/lib/domain/kinds";
import { useSelectedFormContext } from "@/lib/routing/hooks";
import { useSessionFocusHint } from "@/lib/session/hooks";
import {
	activeHiddenValueMode,
	HIDDEN_VALUE_MODES,
	type HiddenValueMode,
	type HiddenValuePatch,
	hiddenValueModeHint,
	hiddenValueModeSwitchPatch,
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
	const mode = activeHiddenValueMode(field);
	const expression = field[mode];
	const projection = useXPathProjection(expression);
	const parseForField = useParseXPathForField(field.uuid);
	const getLintContext = useFormLintContext(field.uuid);
	const focusHint = useSessionFocusHint();
	const context = useSelectedFormContext();
	const preloads =
		context !== null &&
		writerPreloadsFromLoadedCase(field, context.module, context.form);
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
		(next: string) =>
			dispatch(
				hiddenValueSavePatch(
					mode,
					next === "" ? undefined : parseForField(next),
				),
			),
		[dispatch, mode, parseForField],
	);
	const switchMode = useCallback(
		(next: HiddenValueMode) => {
			const patch = hiddenValueModeSwitchPatch(field, next);
			if (patch !== null) dispatch(patch);
		},
		[dispatch, field],
	);

	/* The inert placeholder a builder-born field carries is not an authored
	 * expression, so the preloaded row treats it as nothing stored. */
	const showsPreloadedRow = mode === "default_value" && preloads;
	const storedText =
		showsPreloadedRow && !isInertHiddenValue(expression) && projection.ok
			? projection.text
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
					storedText={storedText}
					onRemoveStored={() =>
						dispatch(hiddenValueSavePatch("default_value", undefined))
					}
				/>
			) : (
				<div data-field-id={mode}>
					<XPathField
						value={projection.text}
						onSave={handleSave}
						getLintContext={getLintContext}
						autoEdit={!!autoFocus || focusHint === mode}
						onEditingChange={setEditing}
					/>
				</div>
			)}
			{!projection.ok && <RejectionInline message={PROJECTION_FAILED} />}
			<RejectionInline message={rejection} />
		</div>
	);
}
