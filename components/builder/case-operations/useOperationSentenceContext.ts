// components/builder/case-operations/useOperationSentenceContext.ts
//
// The labels a row sentence needs from outside the operation, for one form,
// subscribed narrowly: the form's type and its own case type for the form's
// own case, and the names of the operations, repeats and fields the others
// point at. The resolution itself is
// `lib/domain/caseOperationDescription.ts::operationSentenceContext`, the one
// `describeCaseOperation` reads, so the row, the rail, a refusal and a move
// all say the same name for the same thing.

"use client";

import { useMemo } from "react";
import { useOperationLabelInputs } from "@/lib/doc/hooks/useCaseOperationFacts";
import type { Uuid } from "@/lib/doc/types";
import {
	type OperationSentenceContext,
	operationSentenceContext,
} from "@/lib/domain";

/**
 * Resolve operation / repeat / field uuids to the author's own words for
 * one form. A uuid that no longer resolves returns `undefined`, and the
 * sentence printer says something true about an unnamed thing rather
 * than rendering the uuid.
 */
export function useOperationSentenceContext(
	formUuid: Uuid | undefined,
): OperationSentenceContext {
	const { form, ownCaseType, fields, fieldOrder, fieldParent, userProperties } =
		useOperationLabelInputs(formUuid);

	return useMemo(
		() =>
			operationSentenceContext({
				formUuid,
				form,
				ownCaseType,
				fields,
				fieldOrder,
				fieldParent,
				userProperties,
			}),
		[
			form,
			formUuid,
			ownCaseType,
			fields,
			fieldOrder,
			fieldParent,
			userProperties,
		],
	);
}
