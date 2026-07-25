// components/builder/case-operations/useOperationSentenceContext.ts
//
// The labels a row sentence needs from outside the operation.
//
// References are identity; text is a projection — a `forEach` holds a
// repeat's uuid and an `op` target holds an operation's, so the words
// "once for each Beds entry" only exist once something resolves those
// uuids against the current document. That resolution is here, in one
// place, so the row, the rail, and a refusal all say the same name for
// the same thing.

"use client";

import { useMemo } from "react";
import type { OperationSentenceContext } from "@/components/builder/case-operations/operationSentence";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import { orderedCaseOperations } from "@/lib/domain";

/**
 * Resolve operation / repeat / field uuids to the author's own words for
 * one form. A uuid that no longer resolves returns `undefined`, and the
 * sentence printer says something true about an unnamed thing rather
 * than rendering the uuid.
 */
export function useOperationSentenceContext(
	formUuid: Uuid,
): OperationSentenceContext {
	const { form, fields } = useBlueprintDocShallow((state) => ({
		form: state.forms[formUuid],
		fields: state.fields,
	}));

	return useMemo(() => {
		const operationNames = new Map(
			orderedCaseOperations(form ?? {}).map((operation) => [
				operation.uuid,
				operation.id,
			]),
		);
		const labelOf = (uuid: Uuid): string | undefined => {
			const field = fields[uuid];
			if (field === undefined) return undefined;
			const label = "label" in field ? (field.label ?? "").trim() : "";
			return label.length > 0 ? label : field.id;
		};
		return {
			operationName: (uuid) => operationNames.get(uuid),
			repeatLabel: labelOf,
			fieldLabel: labelOf,
		};
	}, [form, fields]);
}
