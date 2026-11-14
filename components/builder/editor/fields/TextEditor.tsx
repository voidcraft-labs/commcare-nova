"use client";
import { useCallback, useId, useState } from "react";
import { RefLabelInput } from "@/components/builder/RefLabelInput";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import {
	FORMAT_TEXT_CONFIRM,
	FORMAT_TEXT_CONFIRM_KEEP,
	FORMAT_TEXT_CONFIRM_OFF,
	FORMAT_TEXT_FOLLOWS_SOURCE,
	FORMAT_TEXT_FORM_OFF,
	FORMAT_TEXT_NAME,
	formatTextGesture,
	formatTextOffLine,
} from "@/components/preview/form/formatText";
import { useHelpFormatText } from "@/components/preview/form/useHelpFormatText";
import type { FormatTextControl } from "@/components/preview/form/useLabelFormatText";
import { Button } from "@/components/shadcn/button";
import { Switch } from "@/components/shadcn/switch";
import { useDeclaredPlatforms } from "@/lib/doc/hooks/useDeclaredPlatforms";
import {
	type CommitOutcome,
	EMPTY_PROSE_TEMPLATE,
	type Field,
	type ProseTemplate,
} from "@/lib/domain";
import type { ProseSlotRef } from "@/lib/domain/expression/types";
import type {
	FieldEditorComponentProps,
	OptionalProseTemplateKeys,
} from "@/lib/domain/kinds";
import { proseTemplateHoldsFormatting } from "@/lib/tiptap/formatText";

/** The prose slot a text editor's key names on its field, where a
 *  calculated value in it is parsed and checked. */
function proseSlotOf(
	fieldUuid: Field["uuid"],
	key: string,
): ProseSlotRef | undefined {
	return key === "label" ||
		key === "hint" ||
		key === "help" ||
		key === "validate_msg"
		? { entity: "field", uuid: fieldUuid, slot: key }
		: undefined;
}

/**
 * A help text's Format text switch, in the label row of its editor. On means
 * the help text is formatted. Under a worker language other than the source,
 * or while the form's text formatting is off, it shows the setting it reads
 * and changes nothing; the line under the editor says why.
 */
function HelpFormatTextSwitch({
	control,
	onToggle,
}: {
	readonly control: FormatTextControl;
	readonly onToggle: () => void;
}) {
	const id = useId();
	const formatted = !control.plain;
	const changeable = control.isSource && !control.formOff;
	return (
		<label
			htmlFor={id}
			className={`flex shrink-0 items-center gap-2 text-xs text-nova-text-secondary ${
				changeable ? "cursor-pointer" : "cursor-not-allowed"
			}`}
		>
			{FORMAT_TEXT_NAME}
			<Switch
				id={id}
				checked={formatted}
				disabled={!changeable}
				data-format-text={formatted ? "on" : "off"}
				onCheckedChange={onToggle}
			/>
		</label>
	);
}

/** The line under a help text's editor while its Format text is off or can't
 *  change. */
function helpFormatTextLine(
	control: FormatTextControl,
	platforms: Parameters<typeof formatTextOffLine>[1],
): string | null {
	if (control.formOff) return FORMAT_TEXT_FORM_OFF;
	if (control.plain) return formatTextOffLine("help", platforms);
	return control.isSource ? null : FORMAT_TEXT_FOLLOWS_SOURCE;
}

/**
 * Adapts optional prose-template slots to RefLabelInput. Absent empty slots
 * are no-ops; clearing authored prose removes the key. Forward each actual
 * commit outcome so a refusal preserves the local editor draft and focus,
 * with one consumer-owned inline notice. The data-field-id restores focus
 * after undo/redo. Generic casts bridge OptionalProseTemplateKeys to F[K].
 */
export function TextEditor<
	F extends Field,
	K extends OptionalProseTemplateKeys<F>,
>(
	props: FieldEditorComponentProps<F, K> & {
		readonly onDismissEmpty?: () => void;
	},
) {
	const { field, value, onChange, label, autoFocus, keyName, onDismissEmpty } =
		props;
	const [rejection, setRejection] = useState<string | null>(null);
	/* A help text carries its own Format text setting (`plainHelp`); a hint
	 * and a validation message have none. */
	const helpFormatText = useHelpFormatText(
		keyName === "help" ? field : undefined,
	);
	const platforms = useDeclaredPlatforms();
	const [confirmingPlain, setConfirmingPlain] = useState(false);
	const current =
		value && typeof value === "object" && "parts" in value
			? (value as ProseTemplate)
			: EMPTY_PROSE_TEMPLATE;

	const handleSave = useCallback(
		(next: ProseTemplate) => {
			// Forward the gated outcome: a refused commit keeps the draft in
			// the input and surfaces the finding inline.
			const outcome = onChange(next as F[K]);
			setRejection(outcome.ok ? null : outcome.messages.join(" "));
			return outcome;
		},
		[onChange],
	);

	const handleEmpty = useCallback(() => {
		// Skip the dispatch when the key is already absent: there is
		// nothing to clear. See the file header for the full rationale.
		if (value === undefined) {
			onDismissEmpty?.();
			return;
		}
		const outcome = onChange(undefined as F[K]);
		setRejection(outcome.ok ? null : outcome.messages.join(" "));
		return outcome;
	}, [onChange, value, onDismissEmpty]);

	const writeFormatText = useCallback(
		(plain: true | null): CommitOutcome | undefined => {
			if (helpFormatText === undefined) return undefined;
			const outcome = helpFormatText.write(plain);
			setRejection(outcome.ok ? null : outcome.messages.join(" "));
			if (outcome.ok) setConfirmingPlain(false);
			return outcome;
		},
		[helpFormatText],
	);

	const toggleFormatText = useCallback(() => {
		if (helpFormatText === undefined || helpFormatText.formOff) return;
		const gesture = formatTextGesture({
			plain: helpFormatText.plain,
			isSource: helpFormatText.isSource,
			holdsFormatting: () => proseTemplateHoldsFormatting(current),
		});
		if (gesture.kind === "confirm") setConfirmingPlain(true);
		else if (gesture.kind === "write") writeFormatText(gesture.plainLabel);
	}, [helpFormatText, current, writeFormatText]);

	const formatLine =
		helpFormatText === undefined
			? null
			: helpFormatTextLine(helpFormatText, platforms);

	return (
		<div>
			<RefLabelInput
				label={label}
				dataFieldId={keyName}
				value={current}
				autoFocus={autoFocus}
				onSave={handleSave}
				onEmpty={handleEmpty}
				proseSlot={proseSlotOf(field.uuid, keyName)}
				labelRight={
					helpFormatText === undefined ? undefined : (
						<HelpFormatTextSwitch
							control={helpFormatText}
							onToggle={toggleFormatText}
						/>
					)
				}
			/>
			{formatLine === null ? null : (
				<p
					data-format-text-line
					className="mt-1.5 text-xs leading-relaxed text-nova-text-muted"
				>
					{formatLine}
				</p>
			)}
			{confirmingPlain && (
				<fieldset
					data-format-text-prompt
					className="m-0 mt-2 min-w-0 rounded-lg border border-white/[0.06] bg-nova-deep/50 p-3"
				>
					<legend className="float-left w-full p-0 text-xs leading-relaxed text-nova-text-secondary">
						{FORMAT_TEXT_CONFIRM}
					</legend>
					<div className="clear-both flex flex-wrap gap-2 pt-2">
						<Button
							type="button"
							variant="secondary"
							data-format-text-confirm="off"
							onClick={() => writeFormatText(true)}
						>
							{FORMAT_TEXT_CONFIRM_OFF}
						</Button>
						<Button
							type="button"
							variant="ghost"
							data-format-text-confirm="keep"
							onClick={() => setConfirmingPlain(false)}
						>
							{FORMAT_TEXT_CONFIRM_KEEP}
						</Button>
					</div>
				</fieldset>
			)}
			<RejectionInline message={rejection} />
		</div>
	);
}
