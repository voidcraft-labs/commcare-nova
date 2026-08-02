// components/builder/case-operations/useOperationSentenceContext.ts
//
// The labels a row sentence needs from outside the operation.
//
// References are identity; text is a projection: a `forEach` holds a
// repeat's uuid and an `op` target holds an operation's, so the words
// "once for each Beds entry" only exist once something resolves those
// uuids against the current document. That resolution is here, in one
// place, so the row, the rail, and a refusal all say the same name for
// the same thing.

"use client";

import { useMemo } from "react";
import type { OperationSentenceContext } from "@/components/builder/case-operations/operationSentence";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { orderedCaseOperations } from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import type { XPathPrintableDoc } from "@/lib/domain/xpath/print";

/** Stable empty stand-ins, so the shallow compare holds across notifications. */
const NO_FIELDS: BlueprintDoc["fields"] = {};
const NO_FIELD_ORDER: BlueprintDoc["fieldOrder"] = {};
const NO_FIELD_PARENT: BlueprintDoc["fieldParent"] = {};

/**
 * Resolve operation / repeat / field uuids to the author's own words for
 * one form. A uuid that no longer resolves returns `undefined`, and the
 * sentence printer says something true about an unnamed thing rather
 * than rendering the uuid.
 */
export function useOperationSentenceContext(
	formUuid: Uuid | undefined,
): OperationSentenceContext {
	/* The label lookup is over a uuid the caller supplies, so it genuinely
	 * needs the whole record, but only once a form resolves. A caller that
	 * holds no form (the rail's hook-order-preserving call while nothing is
	 * selected) would otherwise subscribe every builder screen to every field
	 * in the app, and re-render the layout on each keystroke in any label.
	 * The ordering/worker families ride the same guard: a label is prose whose
	 * references only spell out against them, so they are read together or not
	 * at all. */
	const { form, fields, fieldOrder, fieldParent, userProperties } =
		useBlueprintDocShallow((state) => {
			const form = formUuid === undefined ? undefined : state.forms[formUuid];
			const idle = form === undefined;
			return {
				form,
				fields: idle ? NO_FIELDS : state.fields,
				fieldOrder: idle ? NO_FIELD_ORDER : state.fieldOrder,
				fieldParent: idle ? NO_FIELD_PARENT : state.fieldParent,
				userProperties: idle ? undefined : state.userProperties,
			};
		});

	return useMemo(() => {
		const operationNames = new Map(
			orderedCaseOperations(form ?? {}).map((operation) => [
				operation.uuid,
				operation.id,
			]),
		);
		const printDoc: XPathPrintableDoc = {
			fields,
			fieldOrder,
			fieldParent,
			userProperties,
			forms:
				form === undefined || formUuid === undefined
					? {}
					: { [formUuid]: form },
		};
		const labelOf = (uuid: Uuid): string | undefined => {
			const field = fields[uuid];
			if (field === undefined) return undefined;
			const label =
				"label" in field && field.label
					? projectProseTemplate(field.label, printDoc).text.trim()
					: "";
			return label.length > 0 ? label : field.id;
		};
		return {
			operationName: (uuid) => operationNames.get(uuid),
			repeatLabel: labelOf,
			fieldLabel: labelOf,
		};
	}, [form, formUuid, fields, fieldOrder, fieldParent, userProperties]);
}
