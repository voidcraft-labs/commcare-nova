/**
 * Normalize every identity-keyed record carried by an in-memory blueprint.
 *
 * JSON.parse and structuredClone both return ordinary objects, even when the
 * source record had a null prototype. Every apply and hydration entry routes
 * through this function so reducers and readers can rely on the final
 * no-inherited-namespace invariant without restricting valid identities.
 */

import type {
	BlueprintDoc,
	PersistableDoc,
	Persona,
	UserType,
} from "@/lib/domain";
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
	/*
	 * `fieldParent` is derived and deliberately absent from every persisted
	 * blueprint. Mutation/diff entry points may therefore receive a widened
	 * PersistableDoc before their final rebuild. Seed the derived record here;
	 * reducers do not read it mid-batch, and applyMutation(s) rebuilds the exact
	 * reverse index before returning.
	 */
	doc.fieldParent =
		doc.fieldParent === undefined
			? recordFromEntries([])
			: normalizeOwnRecord(doc.fieldParent);

	if (doc.userProperties !== undefined) {
		doc.userProperties = normalizeOwnRecord(doc.userProperties);
	}
	if (doc.userTypes !== undefined) {
		doc.userTypes = normalizeUserDataCollection(doc.userTypes);
	}
	if (doc.personas !== undefined) {
		doc.personas = normalizeUserDataCollection(doc.personas);
	}
	if (doc.organizationLevels !== undefined) {
		doc.organizationLevels = normalizeOwnRecord(doc.organizationLevels);
	}
	if (doc.locationProperties !== undefined) {
		doc.locationProperties = normalizeOwnRecord(doc.locationProperties);
	}
	if (doc.automations !== undefined) {
		doc.automations = normalizeOwnRecord(doc.automations);
	}
	if (doc.localization !== undefined) {
		doc.localization.translations = normalizeOwnRecord(
			doc.localization.translations,
		);
		for (const [code, translations] of Object.entries(
			doc.localization.translations,
		)) {
			doc.localization.translations[code] = normalizeOwnRecord(translations);
		}
	}
}

/**
 * Cross a React Server Component boundary without leaking the in-memory
 * null-prototype representation into Flight. React accepts ordinary objects
 * only; the structured clone keeps every enumerable own key (including
 * `__proto__`) while rebuilding record objects with `Object.prototype`.
 *
 * `BlueprintDocProvider` hydrates this transport copy back through
 * `normalizeBlueprintOwnRecords` before any client-side document read.
 */
export function toRscSerializableDoc(doc: PersistableDoc): PersistableDoc {
	return structuredClone(doc);
}
