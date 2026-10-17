/**
 * Step `entry-point-ids`: rewrites each deep link id CommCare HQ would not
 * save as written. HQ answers 400 unless an endpoint id equals Django's
 * `slugify` of itself (`views/utils.py::get_cleaned_session_endpoint_id`),
 * which `lib/domain/entryPoints.ts::entryPointIdProblem` states over the ids
 * Nova admits (part 08 of step 2's plan, Defect 15).
 *
 * Ids are unique across the app. The ids that pass are taken first, in the
 * order the app lists its entry points (each menu's, its case list's, then
 * its forms'), and each refused id becomes `editorSafeEntryPointId(id)`
 * (`entry` when nothing survives), suffixed until free.
 *
 * One `entry-point-renamed` line per entry point, naming it, with the old
 * and new ids.
 */

import { asUuid } from "@/lib/domain";
import {
	editorSafeEntryPointId,
	entryPointIdProblem,
} from "@/lib/domain/entryPoints";
import { suffixUntilFree } from "@/lib/domain/idSlug";
import type { JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { isRecord, rawText } from "./relativePaths";

/** Every stored entry point, in the order the app lists them. */
function entryPoints(document: RawDocument): JsonRecord[] {
	const found: JsonRecord[] = [];
	for (const moduleUuid of document.moduleOrder) {
		const module = document.modules[moduleUuid];
		for (const slot of [module?.entryPoint, module?.caseListEntryPoint]) {
			if (isRecord(slot)) found.push(slot);
		}
		for (const formUuid of document.formOrder[moduleUuid] ?? []) {
			const slot = document.forms[formUuid]?.entryPoint;
			if (isRecord(slot)) found.push(slot);
		}
	}
	return found;
}

export const entryPointIdsStep: CutoverStep = {
	id: "entry-point-ids",
	apply(document) {
		const points = entryPoints(document);
		const taken = new Set(
			points
				.map((point) => rawText(point.id))
				.filter((id) => entryPointIdProblem(id) === undefined),
		);
		const changes: DocumentChange[] = [];
		for (const point of points) {
			const from = rawText(point.id);
			if (entryPointIdProblem(from) === undefined) continue;
			const to = suffixUntilFree(editorSafeEntryPointId(from), taken);
			taken.add(to);
			(point as { id: string }).id = to;
			changes.push({
				reason: "entry-point-renamed",
				entity: {
					type: "entryPoint",
					uuid: asUuid(rawText(point.uuid)),
					nameAtMigration: to,
				},
				detail: { from, to },
			});
		}
		return changes;
	},
};
