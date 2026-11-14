"use client";

import { useMemo } from "react";
import { useShowsSourceLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import {
	type CommitOutcome,
	type Field,
	type FieldPatchFor,
	labelShowsAsTyped,
} from "@/lib/domain";

/** The Format text toggle a label's inline editor or a help text's editor
 *  shows. */
export interface FormatTextControl {
	/** The text shows exactly as stored: it holds its own setting
	 *  (`plainLabel`, `plainHelp`), or its form's text formatting is off. */
	readonly plain: boolean;
	/** The form's text formatting is off (`Form.plainText`): the toggle shows
	 *  off and changes nothing, and the text's own setting is kept for when
	 *  the form's switch goes back on. */
	readonly formOff: boolean;
	/** The builder shows the source language, which owns the setting. Under
	 *  another worker language the toggle shows the source's state read-only. */
	readonly isSource: boolean;
	/** Write the text's own setting (`true` turns formatting off, `null` turns
	 *  it on) as one `updateField`, one undo step. */
	write(plain: true | null): CommitOutcome;
}

/**
 * The Format text control for a question, group, repeat or section label.
 * Undefined for a field kind with no label of its own (a hidden value), whose
 * label editor never opens.
 */
export function useLabelFormatText(
	field: Field | undefined,
): FormatTextControl | undefined {
	const { updateField } = useBlueprintMutations();
	const isSource = useShowsSourceLanguage();
	const textForm = useFieldTextForm(field?.uuid);
	const uuid = field?.uuid;
	const kind = field?.kind;
	const plain =
		field !== undefined &&
		labelShowsAsTyped(textForm, "plainLabel" in field ? field : {});
	const formOff = textForm.plainText === true;
	return useMemo(() => {
		if (uuid === undefined || kind === undefined || kind === "hidden") {
			return undefined;
		}
		return {
			plain,
			formOff,
			isSource,
			write: (plainLabel) =>
				updateField(uuid, kind, { plainLabel } as FieldPatchFor<typeof kind>),
		};
	}, [uuid, kind, plain, formOff, isSource, updateField]);
}
