"use client";

import { useMemo } from "react";
import { useShowsSourceLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { CommitOutcome, Field, FieldPatchFor } from "@/lib/domain";
import { ownerHoldsPlainLabel } from "@/lib/references/LabelContent";

/** The Format text toggle a label's inline editor shows. */
export interface FormatTextControl {
	/** The text holds `plainLabel`: it shows exactly as stored. */
	readonly plain: boolean;
	/** The builder shows the source language, which owns the setting. Under
	 *  another worker language the toggle shows the source's state read-only. */
	readonly isSource: boolean;
	/** Write `plainLabel` (`true` turns formatting off, `null` turns it on)
	 *  as one `updateField`, one undo step. */
	write(plainLabel: true | null): CommitOutcome;
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
	const uuid = field?.uuid;
	const kind = field?.kind;
	const plain = ownerHoldsPlainLabel(field);
	return useMemo(() => {
		if (uuid === undefined || kind === undefined || kind === "hidden") {
			return undefined;
		}
		return {
			plain,
			isSource,
			write: (plainLabel) =>
				updateField(uuid, kind, { plainLabel } as FieldPatchFor<typeof kind>),
		};
	}, [uuid, kind, plain, isSource, updateField]);
}
