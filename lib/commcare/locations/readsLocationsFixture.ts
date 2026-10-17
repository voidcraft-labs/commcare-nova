/**
 * Which forms of an app read `jr://fixture/locations`.
 *
 * Exactly one term does: `owner-location-at-level`, which
 * `predicate/termEmitter.ts::emitTerm` lowers to an
 * `instance('locations')` path, and which
 * `predicate/instances.ts::collectAstInstances` is the accumulator for.
 * `fixed-location` reads no instance (it prints a literal), so an app
 * whose only place rule is that one needs nothing from the restore.
 *
 * Read off the owner slots directly rather than off the instance
 * accumulator, because publish asks this of the whole document before any
 * per-expression emission context exists.
 *
 * A worker's restore holds the flat location list only where the project
 * space sends it (every app carries `location_fixture_restore:
 * "project_default"`, `hqShells.ts::applicationShell`), so publish asks the
 * person to confirm that for an app this names any form of, and the plan
 * privilege `locations` follows the same forms.
 */

import { orderedFormUuids, orderedModuleUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/predicate";

/** The forms whose case operations set an owner from a place at a level of
 * the organization, in the document's form order. */
export function formsReadingLocationsFixture(doc: BlueprintDoc): Uuid[] {
	const forms: Uuid[] = [];
	for (const moduleUuid of orderedModuleUuids(doc)) {
		for (const formUuid of orderedFormUuids(doc, moduleUuid)) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const reads = (form.caseOperations ?? []).some((operation) => {
				if (operation.owner === undefined) return false;
				let found = false;
				walkExpressionTerms(operation.owner, (term) => {
					if (term.kind === "owner-location-at-level") found = true;
				});
				return found;
			});
			if (reads) forms.push(formUuid);
		}
	}
	return forms;
}

/** Whether this app's wire reads `jr://fixture/locations`. */
export function readsLocationsFixture(doc: BlueprintDoc): boolean {
	return formsReadingLocationsFixture(doc).length > 0;
}
