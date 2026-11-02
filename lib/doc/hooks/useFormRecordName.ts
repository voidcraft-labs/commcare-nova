"use client";

import { useMemo } from "react";
import { projectFormExpression } from "@/lib/doc/expressionText";
import {
	formRecordName,
	prepareFormRecordName,
} from "@/lib/doc/formRecordName";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { Uuid } from "@/lib/domain";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The record name's projection in its own slot, the name of the form's
 *  own case, with the slot an edit parses in. */
export function useFormRecordName(formUuid: Uuid) {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	return useMemo(() => {
		const value = formRecordName(doc, formUuid);
		const prepared = prepareFormRecordName(doc, formUuid);
		if (value === undefined || prepared === undefined) return undefined;
		const projection = projectFormExpression(
			doc,
			prepared.slot,
			value,
			lookupExpressionDefinitions(lookupContext),
			// The record name's editor shows it as every editor does: laid
			// out over lines past the printer's width.
			{ form: prepared.form, layout: true },
		);
		return { ...projection, ok: projection.unresolved.length === 0, prepared };
	}, [doc, formUuid, lookupContext]);
}
