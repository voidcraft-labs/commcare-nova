/**
 * Which forms of an app read `jr://fixture/locations`.
 *
 * The wire serializer's returned dependencies decide whether a place
 * destination reads the fixture. `validator/rules/caseOperations.ts::
 * validateTextExpression` currently admits a location term only as the
 * complete owner value, so these are the complete candidate expressions.
 * Case-row anchoring changes the owner-id operand, never the location root.
 * A fixed location prints a literal and contributes no declaration.
 *
 * PR9's general location arms must broaden this to every admitted expression
 * carrier when that gate changes; do not add another domain-term walker.
 *
 * A worker's restore holds the flat location list only where the project
 * space sends it (every app carries `location_fixture_restore:
 * "project_default"`, `hqShells.ts::applicationShell`), so publish asks the
 * person to confirm that for an app this names any form of, and the plan
 * privilege `locations` follows the same forms.
 */

import { orderedFormUuids, orderedModuleUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { requireExpressionContext } from "../expressionContext";
import { toWire } from "../xpath/wire/fromExpression";
import { locationsInstance } from "../xpath/wire/instances";
import { serializeWire } from "../xpath/wire/serialize";

/** The forms whose case operations set an owner from a place at a level of
 * the organization, in the document's form order. */
export function formsReadingLocationsFixture(doc: BlueprintDoc): Uuid[] {
	const forms: Uuid[] = [];
	const locationDeclaration = locationsInstance();
	for (const moduleUuid of orderedModuleUuids(doc)) {
		for (const formUuid of orderedFormUuids(doc, moduleUuid)) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const reads = (form.caseOperations ?? []).some((operation) => {
				const owner = operation.owner;
				if (
					owner?.kind !== "term" ||
					(owner.term.kind !== "owner-location-at-level" &&
						owner.term.kind !== "fixed-location")
				)
					return false;
				const printed = serializeWire(
					toWire(owner, {
						target: "xform",
						types: requireExpressionContext(doc, {
							entity: "form",
							uuid: formUuid,
							slot: "case_operation_owner",
							member: { operationUuid: operation.uuid },
						}),
					}),
					{ target: "xform", constraint: false },
				);
				return [...printed.instances].some(
					(declaration) =>
						declaration.id === locationDeclaration.id &&
						declaration.src === locationDeclaration.src,
				);
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
