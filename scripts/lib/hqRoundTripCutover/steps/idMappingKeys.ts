/**
 * Step `id-mapping-keys`: removes each ID-mapping entry whose value holds
 * `&`, `<`, `>`, `"` or `'`, with its translations in every language, so the
 * document passes `CASE_LIST_ID_MAPPING_KEY_CHARACTERS`. CommCare HQ stores
 * an ID mapping as an `enum` column keyed by the entry values, and has no way
 * to hold a key with one of the five: its build writes the key unescaped
 * into the column's expression, and its mapping dialog refuses it. A case
 * whose value was that key now shows nothing in the column, as a value with
 * no entry does.
 *
 * One `id-mapping-entry-removed` line per entry, naming the column, with the
 * menu's name and the removed value.
 */

import {
	idMappingValueHoldsForbiddenCharacter,
	makeTranslationUnitId,
} from "@/lib/domain";
import type { Json, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import {
	columnEntity,
	menuName,
	rawCaseLists,
	writableRecord,
} from "./caseLists";
import { isRecord, rawText } from "./relativePaths";

/** Delete each named translation unit, in every language. */
function removeTranslationUnits(
	document: RawDocument,
	unitIds: readonly string[],
): void {
	if (unitIds.length === 0 || !isRecord(document.localization)) return;
	const translations = document.localization.translations;
	if (!isRecord(translations)) return;
	for (const entries of Object.values(translations)) {
		if (!isRecord(entries)) continue;
		const writable = entries as Record<string, Json>;
		for (const unitId of unitIds) delete writable[unitId];
	}
}

export const idMappingKeysStep: CutoverStep = {
	id: "id-mapping-keys",
	apply(document) {
		const changes: DocumentChange[] = [];
		const removedUnits: string[] = [];
		for (const list of rawCaseLists(document)) {
			for (const column of list.columns) {
				if (column.kind !== "id-mapping" || !Array.isArray(column.mapping)) {
					continue;
				}
				const kept: Json[] = [];
				for (const entry of column.mapping) {
					const value = isRecord(entry) ? rawText(entry.value) : "";
					if (!idMappingValueHoldsForbiddenCharacter(value)) {
						kept.push(entry);
						continue;
					}
					removedUnits.push(
						makeTranslationUnitId(
							"column",
							rawText(column.uuid),
							"mapping",
							value,
						),
					);
					changes.push({
						reason: "id-mapping-entry-removed",
						entity: columnEntity(column),
						detail: { menu: menuName(list), value },
					});
				}
				if (kept.length !== column.mapping.length) {
					writableRecord(column).mapping = kept;
				}
			}
		}
		removeTranslationUnits(document, removedUnits);
		return changes;
	},
};
