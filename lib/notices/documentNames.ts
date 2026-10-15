/**
 * Names a notice line gives an entity, read from the app's document as it
 * is now. The builder passes this over the document it holds and `get_app`
 * over the one it loads, so a renamed entity reads by its new name and a
 * removed one falls back to the name it had when the cutover ran.
 *
 * Lookup tables and places live outside the document (Project data and the
 * app's organization store), so the document cannot vouch for them: their
 * lines show the stored name. Client-safe.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { entryPointByUuid } from "@/lib/domain/entryPoints";
import { ownRecordValue } from "@/lib/domain/records";
import type { NoticeEntityRef } from "./migrationNotice";
import type { NoticeRenderContext } from "./migrationNoticeCopy";

export function documentNoticeNames(doc: BlueprintDoc): NoticeRenderContext {
	return { nameOf: (entity) => nameInDocument(doc, entity) };
}

function nameInDocument(
	doc: BlueprintDoc,
	entity: NoticeEntityRef,
): string | null {
	const uuid = entity.uuid;
	switch (entity.type) {
		case "app":
			return doc.appName;
		case "language":
			return entity.languageTag !== undefined &&
				(doc.localization?.languageOrder ?? []).includes(entity.languageTag)
				? entity.nameAtMigration
				: null;
		case "lookupTable":
		case "location":
			return null;
	}
	if (uuid === undefined) return null;
	switch (entity.type) {
		case "module":
			return ownRecordValue(doc.modules, uuid)?.name ?? null;
		case "form":
			return ownRecordValue(doc.forms, uuid)?.name ?? null;
		case "field":
			return ownRecordValue(doc.fields, uuid)?.id ?? null;
		case "entryPoint":
			return entryPointByUuid(doc, uuid)?.entryPoint.id ?? null;
		case "caseListColumn":
			for (const module of Object.values(doc.modules)) {
				const column = module.caseListConfig?.columns.find(
					(candidate) => candidate.uuid === uuid,
				);
				if (column !== undefined) return column.header;
			}
			return null;
		case "searchInput":
			for (const module of Object.values(doc.modules)) {
				const input = module.caseListConfig?.searchInputs.find(
					(candidate) => candidate.uuid === uuid,
				);
				if (input !== undefined) return input.label || input.name;
			}
			return null;
	}
}
