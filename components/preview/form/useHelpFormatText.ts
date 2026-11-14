"use client";

import { useMemo } from "react";
import { useShowsSourceLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useFieldTextForm } from "@/lib/doc/hooks/useFieldTextForm";
import {
	type Field,
	type FieldPatchFor,
	fieldKindDeclaresKey,
	helpShowsAsTyped,
} from "@/lib/domain";
import type { FormatTextControl } from "./useLabelFormatText";

/**
 * The Format text control for a question's help text, the same control a
 * label's inline editor shows: `plain` is the help text showing as typed (the
 * question holds `plainHelp`, or its form's text formatting is off), and
 * `write(true | null)` patches `plainHelp` in one `updateField`. Undefined for
 * a kind whose schema holds no `help`.
 */
export function useHelpFormatText(
	field: Field | undefined,
): FormatTextControl | undefined {
	/* The inline flavor: the help text's editor shows a refusal itself. */
	const { inline } = useBlueprintMutations();
	const isSource = useShowsSourceLanguage();
	const textForm = useFieldTextForm(field?.uuid);
	const uuid = field?.uuid;
	const kind = field?.kind;
	const plain =
		field !== undefined &&
		helpShowsAsTyped(textForm, "plainHelp" in field ? field : {});
	const formOff = textForm.plainText === true;
	return useMemo(() => {
		if (
			uuid === undefined ||
			kind === undefined ||
			!fieldKindDeclaresKey(kind, "help")
		) {
			return undefined;
		}
		return {
			plain,
			formOff,
			isSource,
			write: (plainHelp) =>
				inline.updateField(uuid, kind, {
					plainHelp,
				} as FieldPatchFor<typeof kind>),
		};
	}, [uuid, kind, plain, formOff, isSource, inline]);
}
