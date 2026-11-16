"use client";

/**
 * Why the builder withholds a choice the gate would refuse: each named
 * batch is reviewed against the live document through the builder's own
 * inline review (`useBlueprintMutations().inline.reviewMany`: admission, the
 * worker-language projection, the identity moves, then the commit verdict),
 * and a refused batch gives the first finding's builder sentence, which is
 * `offeredChoiceRefusal`'s answer for the same findings. A choice whose batch
 * is admitted, or that plans nothing, gives no refusal.
 *
 * The document is read only while `enabled`, so a control that is hidden or
 * whose author cannot edit subscribes to nothing. `plan` should be stable
 * across renders (a `useCallback`): it is the memo's key with the document.
 */

import { useMemo } from "react";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { afterEmptySearchRegistrationFormOf } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";
import { useBlueprintMutations } from "./useBlueprintMutations";

const NO_REFUSALS: Readonly<Record<string, string>> = Object.freeze({});

export function useOfferedBatchRefusals<K extends string>(
	plan: (
		doc: BlueprintDoc,
	) => Readonly<Partial<Record<K, readonly Mutation[]>>>,
	enabled: boolean,
): Readonly<Partial<Record<K, string>>> {
	const doc = useBlueprintDoc((state) => (enabled ? state : undefined));
	const { inline } = useBlueprintMutations();
	return useMemo(() => {
		if (doc === undefined)
			return NO_REFUSALS as Readonly<Partial<Record<K, string>>>;
		const refusals: Partial<Record<K, string>> = {};
		const batches = plan(doc);
		for (const key of Object.keys(batches) as K[]) {
			const batch = batches[key];
			if (batch === undefined || batch.length === 0) continue;
			const reviewed = inline.reviewMany([...batch]);
			if (!reviewed.ok)
				refusals[key] =
					reviewed.messages[0] ?? "This choice isn't available here.";
		}
		return refusals;
	}, [doc, inline, plan]);
}

/** Whether the form is its module's case list registration form, the one
 *  form of a module on no menu. */
export function useIsCaseListRegistrationForm(
	moduleUuid: Uuid | undefined,
	formUuid: Uuid | undefined,
): boolean {
	return useBlueprintDoc(
		(doc) =>
			moduleUuid !== undefined &&
			formUuid !== undefined &&
			afterEmptySearchRegistrationFormOf(doc, moduleUuid) === formUuid,
	);
}
