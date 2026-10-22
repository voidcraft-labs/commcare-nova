"use client";

import { useMemo, useState } from "react";
import { projectFormExpression } from "@/lib/doc/expressionText";
import {
	formRecordName,
	prepareFormRecordName,
} from "@/lib/doc/formRecordName";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import { asUuid, type Uuid } from "@/lib/domain";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Record-name editing owns its prospective hidden field before parsing. */
export function useFormRecordName(formUuid: Uuid) {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	const [prospectiveUuid, setProspectiveUuid] = useState(() =>
		asUuid(crypto.randomUUID()),
	);
	// A successful edit consumes the reservation. Keep a fresh spare before
	// a later accepted edit can assign the record name to another answer.
	// React retries this render before publishing its result to children.
	const occupied = doc.fields[prospectiveUuid] !== undefined;
	if (occupied) setProspectiveUuid(asUuid(crypto.randomUUID()));
	return useMemo(() => {
		if (occupied) return undefined;
		const value = formRecordName(doc, formUuid);
		const prepared = prepareFormRecordName(doc, formUuid, prospectiveUuid);
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
	}, [doc, formUuid, lookupContext, prospectiveUuid, occupied]);
}
