/**
 * The placements a publish records: every place the emission of a document
 * derives for a case change or a query repeat that the document does not
 * hold yet. Recording them as held placements pins the paths this emission
 * writes, so every later emission keeps them. Holding what the emission
 * already derives changes no byte of the HQ import body or the `.ccz`
 * (`__tests__/heldPlacementEmission.test.ts` holds that over the XForm fuzz
 * documents).
 *
 * Client-safe: the publish, the proof capture and the tests read it.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { PlacementHold } from "@/lib/doc/placementHolds";
import { type BlueprintDoc, ownRecordValue, type Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { appPlacements, planBasicSubcases } from "./placement";

/** A hold that sets a value: what a publish records (declared in `lib/doc/placementHolds.ts`). */
export type { PlacementHold } from "@/lib/doc/placementHolds";

/**
 * Every placement the emission of `doc` derives and `doc` does not hold yet, in document order: the
 * holds a publish records so that every later emission keeps the paths this one sends.
 *
 * Document order is `readPlacementHolds`'s: modules in `moduleOrder`, their
 * forms in `formOrder`, and for each form its operations in array order, its
 * own close, then its query repeats in field order.
 */
export function placementsToHold(doc: BlueprintDoc): readonly PlacementHold[] {
	const holds: PlacementHold[] = [];
	for (const [formUuid, { placements }] of appPlacements(doc)) {
		const form = ownRecordValue(doc.forms, formUuid);
		if (form === undefined) continue;

		// A field-written child kept as HQ's inert subcase beside an active
		// block in the source has two places, its `subcases` entry and its
		// block, and no one hold expresses both: holding the block takes the
		// create out of `subcases`, which renumbers every later subcase.
		const inSource = new Set(
			planBasicSubcases(doc, formUuid)
				.filter((subcase) => subcase.inSource)
				.map((subcase) => subcase.operationUuid),
		);

		// A case operation the plan placed without a hold, at the place the
		// plan gave it: its basic slot, or its Save to Case path as the
		// allocator named it.
		for (const operation of form.caseOperations ?? []) {
			if (inSource.has(operation.uuid)) continue;
			const planned = placements.get(operation.uuid);
			if (planned === undefined || planned.held) continue;
			holds.push({
				target: "case-operation",
				formUuid,
				operationUuid: operation.uuid,
				placement: planned.placement,
			});
		}

		// The own close holds a place only where it has its own block: a close
		// written in the own arm's place (`sharesWith`) has none of its own.
		const ownClose = placements.get("own-close");
		if (
			ownClose !== undefined &&
			!ownClose.held &&
			ownClose.sharesWith === undefined &&
			ownClose.placement.kind === "save-to-case" &&
			form.ownClosePlacement === undefined
		)
			holds.push({
				target: "own-close",
				formUuid,
				placement: { kind: "save-to-case", path: ownClose.placement.path },
			});

		const structure = formStructure(doc, formUuid);
		if (structure === undefined) continue;
		const walk = (parentUuid: Uuid): void => {
			for (const fieldUuid of orderedFieldUuids(doc, parentUuid)) {
				const field = ownRecordValue(doc.fields, fieldUuid);
				if (field === undefined) continue;
				if (
					field.kind === "repeat" &&
					field.repeat_mode === "query_bound" &&
					field.placement === undefined
				)
					holds.push({
						target: "query-repeat",
						fieldUuid,
						placement: effectiveQueryRepeatPlacement(structure, fieldUuid),
					});
				walk(fieldUuid);
			}
		};
		walk(formUuid);
	}
	return holds;
}
