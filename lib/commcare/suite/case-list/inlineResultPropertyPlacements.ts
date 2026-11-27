import {
	type BlueprintDoc,
	type Column,
	type Module,
	moduleFormsReadSearch,
	moduleHasCaseListMenuItem,
	moduleSearchWorkflow,
	projectSearchOf,
} from "@/lib/domain";
import { effectiveDataType } from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	caseListSessionDatums,
	entrySessionDatums,
	formLinkProjectionContext,
	moduleIndexOf,
} from "../../formLinkProjection";
import { emittedModuleKind } from "../../moduleKind";
import type { SessionDatum } from "../../session";
import { inlineSearchInstance } from "../case-search/types";
import {
	DEFAULT_INLINE_RESULT_INSTANCE,
	ownInlineResultProperty,
} from "./inlineResultProperty";

export function inlineResultPropertyColumnSupported(
	doc: BlueprintDoc,
	module: Module,
	column: Extract<Column, { kind: "calculated" }>,
): boolean {
	const config = module.caseListConfig;
	const property = ownInlineResultProperty(column, module.caseType);
	if (
		config === undefined ||
		property === undefined ||
		!moduleFormsReadSearch(module) ||
		moduleSearchWorkflow(module) !== "searchFirst" ||
		projectSearchOf(module) !== undefined ||
		module.caseListRegistrationForm !== undefined ||
		inlineSearchInstance(module.searchResultsName) !==
			DEFAULT_INLINE_RESULT_INSTANCE ||
		config.tile !== undefined ||
		config.detailTile !== undefined ||
		config.detailTabs !== undefined ||
		config.selection !== undefined ||
		column.notOnList ||
		column.visibleInList === false ||
		column.visibleInDetail !== false ||
		column.sort !== undefined ||
		column.texts !== undefined ||
		column.showAs !== undefined ||
		column.rowField !== undefined ||
		column.loadBehavior !== undefined ||
		column.searchResultDetail !== undefined
	)
		return false;

	return (
		effectiveCaseTypes(doc)
			.find((kind) => kind.name === module.caseType)
			?.properties.some(
				(candidate) =>
					candidate.name === property &&
					effectiveDataType(candidate) === "text",
			) ?? false
	);
}

/** A detail can belong to an entry in another menu. Use the actual projected
 * datums and their source identity, not merely the menu's Search setting or
 * an instance declaration (a column's own XPath can cause that declaration).
 */
export function inlineResultPropertyPlacementsSupported(
	doc: BlueprintDoc,
	module: Module,
): boolean {
	if (emittedModuleKind(doc, module.uuid) !== "basic") return false;
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const index = moduleIndexOf(ctx, module.uuid);
	const detail = `m${index}_case_short`;
	let seen = false;
	const valid = (datums: readonly SessionDatum[]) =>
		datums.every((datum, at) => {
			const referenced = [
				datum.detailSelect,
				datum.detailConfirm,
				datum.detailPersistent,
				datum.detailInline,
			];
			if (!referenced.includes(detail)) return true;
			seen = true;
			const previous = datums[at - 1];
			return (
				datum.caseType === module.caseType &&
				ctx.selectionSourceModules.get(datum) === module.uuid &&
				previous?.query?.storageInstance === DEFAULT_INLINE_RESULT_INSTANCE &&
				ctx.queryNextDatums.get(previous) === datum
			);
		});
	for (const moduleUuid of ctx.moduleOrder) {
		const entry = doc.modules[moduleUuid];
		if (entry === undefined) continue;
		if (
			moduleHasCaseListMenuItem(entry) &&
			!valid(caseListSessionDatums(doc, ctx, moduleUuid))
		)
			return false;
		for (const formUuid of ctx.formOrder[moduleUuid] ?? [])
			if (!valid(entrySessionDatums(doc, ctx, moduleUuid, formUuid)))
				return false;
	}
	return seen;
}
