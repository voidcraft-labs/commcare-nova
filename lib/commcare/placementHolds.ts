/**
 * The placements a publish records: every place the emission of a document
 * derives for a case change, a query repeat or a menu's advanced kind that
 * the document does not hold yet. Recording them as held placements pins
 * the paths this emission writes, so every later emission keeps them.
 * Holding what the emission already derives changes no byte of the HQ
 * import body or the `.ccz` (`__tests__/heldPlacementEmission.test.ts`
 * holds that over the XForm fuzz documents and the advanced ones).
 *
 * Client-safe: the publish, the proof capture and the tests read it.
 */

import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import type { PlacementHold } from "@/lib/doc/placementHolds";
import { type BlueprintDoc, ownRecordValue, type Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import { emittedModuleKind } from "./moduleKind";
import {
	appPlacements,
	type FormPlacements,
	planBasicSubcases,
} from "./placement";

/** A hold that sets a value: what a publish records (declared in `lib/doc/placementHolds.ts`). */
export type { PlacementHold } from "@/lib/doc/placementHolds";

/**
 * Every placement the emission of `doc` derives and `doc` does not hold yet, in document order: the
 * holds a publish records so that every later emission keeps the paths this one sends.
 *
 * Document order is `readPlacementHolds`'s: modules in `moduleOrder`, each
 * module's kind first, then its forms in `formOrder`, and for each form its
 * operations in array order, its own close, then its query repeats in field
 * order.
 */
export function placementsToHold(doc: BlueprintDoc): readonly PlacementHold[] {
	const holds: PlacementHold[] = [];
	const plans = appPlacements(doc);
	for (const moduleUuid of doc.moduleOrder) {
		// A menu emitted advanced that holds no kind yet: holding it keeps
		// every form's `case_<tag>` paths and `case_id_<tag>` session values
		// once the link that made it advanced goes.
		const module = ownRecordValue(doc.modules, moduleUuid);
		if (
			module !== undefined &&
			module.heldKind === undefined &&
			emittedModuleKind(doc, moduleUuid) === "advanced"
		)
			holds.push({ target: "module-kind", moduleUuid, placement: "advanced" });
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const planned = plans.get(formUuid);
			if (planned !== undefined) formHolds(doc, formUuid, planned, holds);
		}
	}
	return holds;
}

/** The holds one form's emission derives and the form does not hold yet,
 *  in `readPlacementHolds`'s order. */
function formHolds(
	doc: BlueprintDoc,
	formUuid: Uuid,
	{ placements }: FormPlacements,
	holds: PlacementHold[],
): void {
	const form = ownRecordValue(doc.forms, formUuid);
	if (form === undefined) return;

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
	// plan gave it: its basic slot, its case action, or its Save to Case
	// path as the allocator named it.
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
	if (structure === undefined) return;
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
