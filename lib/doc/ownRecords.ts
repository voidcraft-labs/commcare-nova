/**
 * Normalize every identity-keyed record carried by an in-memory blueprint.
 *
 * JSON.parse and structuredClone both return ordinary objects, even when the
 * source record had a null prototype. Every apply and hydration entry routes
 * through this function so reducers and readers can rely on the final
 * no-inherited-namespace invariant without restricting valid identities.
 */

import type { BlueprintDoc, Persona, UserType } from "@/lib/domain";
import {
	isOwnRecord,
	normalizeOwnRecord,
	recordFromEntries,
} from "@/lib/domain";

type UserDataCarrier = UserType | Persona;

function normalizeUserDataCollection<T extends UserDataCarrier>(
	record: Record<string, T>,
): Record<string, T> {
	let changed = !isOwnRecord(record);
	const entries = Object.entries(record).map(([uuid, entity]) => {
		if (entity.values === undefined || isOwnRecord(entity.values)) {
			return [uuid, entity] as const;
		}
		changed = true;
		return [
			uuid,
			{ ...entity, values: normalizeOwnRecord(entity.values) } as T,
		] as const;
	});
	return changed ? recordFromEntries(entries) : record;
}

export function normalizeBlueprintOwnRecords(doc: BlueprintDoc): void {
	doc.modules = normalizeOwnRecord(doc.modules);
	doc.forms = normalizeOwnRecord(doc.forms);
	doc.fields = normalizeOwnRecord(doc.fields);
	doc.formOrder = normalizeOwnRecord(doc.formOrder);
	doc.fieldOrder = normalizeOwnRecord(doc.fieldOrder);
	doc.fieldParent = normalizeOwnRecord(doc.fieldParent);

	if (doc.userProperties !== undefined) {
		doc.userProperties = normalizeOwnRecord(doc.userProperties);
	}
	if (doc.userTypes !== undefined) {
		doc.userTypes = normalizeUserDataCollection(doc.userTypes);
	}
	if (doc.personas !== undefined) {
		doc.personas = normalizeUserDataCollection(doc.personas);
	}
}
