// lib/doc/optionRemoval.ts
//
// Whether a select's choice can be removed, asked of the reference index.
//
// A formula names a choice by its option UUID (`choice`), so removing the
// option would leave that formula naming nothing; the commit gate refuses the
// removal as a dangling identity for every editor. The options editor asks the
// same index first (`hooks/useOptionRemovalBlockers.ts`), so its remove
// control is disabled with the reader named rather than offered and then
// bounced.

import type { BlueprintDoc, ProseTemplate, Uuid } from "@/lib/domain";
import { expressionSlotLabel } from "@/lib/domain/expression/slotLabels";
import type { SlotContextRef } from "@/lib/domain/expression/types";
import { entityTargetKey } from "@/lib/domain/referenceIndex";
import { referencingSlotsOf } from "./referenceIndex";

const CHANGE_FIRST = "You can change that first.";

/** Why this option cannot be removed, or `undefined` when nothing reads it.
 * A starting value is named before any other reader, then readers in the
 * index's order, and only the first one is said: the control's reason is one
 * sentence, and once that reader changes the next one is named. */
export function optionRemovalBlocker(
	doc: BlueprintDoc,
	optionUuid: Uuid,
	projectProse: (template: ProseTemplate) => string,
): string | undefined {
	const readers = referencingSlotsOf(doc, entityTargetKey(optionUuid));
	const sentences: { readonly first: boolean; readonly text: string }[] = [];
	for (const [carrier, slots] of readers) {
		const field = doc.fields[carrier as Uuid];
		if (field !== undefined) {
			const label =
				"label" in field && field.label !== undefined
					? projectProse(field.label).trim()
					: "";
			const question = label.length > 0 ? label : field.id;
			for (const slot of slots)
				sentences.push(
					slot === "default_value"
						? {
								first: true,
								text: `This choice is the starting value of ${question}.`,
							}
						: {
								first: false,
								text: `${question}'s ${slotLabel(slot)} compares with this choice.`,
							},
				);
			continue;
		}
		const form = doc.forms[carrier as Uuid];
		if (form !== undefined) {
			for (const slot of slots)
				sentences.push({
					first: false,
					text: slot.startsWith("case_operation_")
						? `A case change in ${form.name} compares with this choice.`
						: `${form.name}'s ${slotLabel(slot)} compares with this choice.`,
				});
			continue;
		}
		const module = doc.modules[carrier as Uuid];
		if (module !== undefined)
			sentences.push({
				first: false,
				text: `A rule in ${module.name} compares with this choice.`,
			});
	}
	const sentence =
		sentences.find((candidate) => candidate.first) ?? sentences[0];
	return sentence === undefined
		? undefined
		: `${sentence.text} ${CHANGE_FIRST}`;
}

function slotLabel(slot: string): string {
	return expressionSlotLabel(slot as SlotContextRef["slot"]);
}
