import { moduleCaseTypeForActions } from "./basicCaseSlots";
import type { BlueprintDoc } from "./blueprint";
import {
	type CasePropertyDataType,
	effectiveDataType,
} from "./casePropertyTypes";
import { effectiveCaseTypes } from "./effectiveCaseTypes";
import { type ExpressionNode, expressionChildren } from "./expression/children";
import {
	activeRowScope,
	type ExpressionContext,
	pushRowScope,
	slotContext,
} from "./expression/context";
import { expressionChildContext } from "./expression/typeChecker";
import { isRelationPath } from "./expression/types";
import {
	caseListColumnRuns,
	effectiveCaseSearchConfig,
	type Module,
	moduleFormsReadSearch,
} from "./modules";
import {
	type ExpressionCarrierRef,
	expressionSlotValues,
} from "./referenceSlots";
import type { Uuid } from "./uuid";

export interface ProjectSearchResultField {
	name: string;
	type: CasePropertyDataType;
}

type ResultReads = Map<Uuid, Map<string, CasePropertyDataType>>;

/** The screen can read a different case inside a result expression. Follow
 * the same row bindings as the expression checker when reporting what a
 * project-space search must return. */
function resultProperties(
	node: ExpressionNode,
	ctx: ExpressionContext,
	fields: Map<string, CasePropertyDataType>,
): void {
	const active = activeRowScope(ctx);
	// A lookup predicate can read its enclosing case as well as its own row.
	const row =
		active?.kind === "table" && node.kind === "prop"
			? active.capturedCase
			: active;
	if (row?.kind === "case" && row.root !== "casedb") {
		const name =
			node.kind === "search-result-field"
				? node.name
				: node.kind === "prop" && (!node.via || node.via.kind === "self")
					? node.property
					: undefined;
		if (name !== undefined) {
			const type =
				node.kind === "prop" ? (node.caseType ?? row.caseType) : row.caseType;
			const property = ctx.facts.caseTypes
				.find((entry) => entry.name === type)
				?.properties.find((entry) => entry.name === name);
			fields.set(name, property ? effectiveDataType(property) : "text");
		}
	}
	for (const child of expressionChildren(node)) {
		if (child.kind === "relation") continue;
		let next = expressionChildContext(node, child, ctx);
		// A relationship's predicate and a form-step filter read different
		// physical nodes, even when they carry the same case type.
		if (
			child.role.kind === "form-step-filter" ||
			(child.role.kind === "operand" &&
				child.role.slot === "where" &&
				(node.kind === "exists" ||
					node.kind === "missing" ||
					node.kind === "count") &&
				isRelationPath(node.via) &&
				node.via.kind !== "self")
		) {
			const bound = activeRowScope(next);
			if (bound?.kind === "case")
				next = pushRowScope(next, { ...bound, root: "casedb" });
		}
		resultProperties(child.value, next, fields);
	}
}

/** Form expressions can reach the directory only through its explicit row source. */
function readsResultRows(node: ExpressionNode): boolean {
	return (
		(node.kind === "cases" && node.source === "search-results") ||
		expressionChildren(node).some(
			(child) => child.kind !== "relation" && readsResultRows(child.value),
		)
	);
}

function resultExpressionReads(doc: BlueprintDoc): ResultReads {
	const reads: ResultReads = new Map();
	const lookup = new Map();
	const visitOwner = (owner: ExpressionCarrierRef) => {
		for (const slot of expressionSlotValues(doc, owner)) {
			if (owner.entity !== "module" && !readsResultRows(slot.expression))
				continue;
			const ctx = slotContext(doc, slot.ref, lookup);
			const supplier = ctx?.supplies.searchResults?.module;
			const module = supplier && doc.modules[supplier];
			if (
				!ctx ||
				!supplier ||
				!module ||
				!effectiveCaseSearchConfig(module)?.projectSearch
			)
				continue;
			const fields = reads.get(supplier) ?? new Map();
			resultProperties(slot.expression, ctx, fields);
			reads.set(supplier, fields);
		}
	};
	for (const form of Object.values(doc.forms))
		visitOwner({ entity: "form", uuid: form.uuid });
	for (const field of Object.values(doc.fields))
		visitOwner({ entity: "field", uuid: field.uuid });
	for (const module of Object.values(doc.modules))
		visitOwner({ entity: "module", uuid: module.uuid });
	return reads;
}

function resultFields(
	doc: BlueprintDoc,
	module: Module,
	expressionReads: ResultReads,
): ProjectSearchResultField[] {
	const fields = new Map<string, CasePropertyDataType>([["case_id", "text"]]);
	const config = module.caseListConfig;
	if (config) {
		const properties = effectiveCaseTypes(doc).find(
			(type) => type.name === module.caseType,
		)?.properties;
		for (const column of config.columns) {
			if (!caseListColumnRuns(column, config)) continue;
			if (column.kind === "calculated") {
				const ctx = slotContext(
					doc,
					{
						entity: "module",
						uuid: module.uuid,
						slot: "case_list_column_expression",
						member: { columnUuid: column.uuid },
					},
					new Map(),
				);
				if (ctx)
					resultProperties(
						column.expression,
						pushRowScope(ctx, {
							kind: "case",
							root: "results",
							caseType: module.caseType,
						}),
						fields,
					);
			} else if (!column.via) {
				const property = properties?.find(
					(entry) => entry.name === column.field,
				);
				fields.set(
					column.field,
					property ? effectiveDataType(property) : "text",
				);
			}
		}
	}
	for (const [name, type] of expressionReads.get(module.uuid) ?? [])
		if (!fields.has(name)) fields.set(name, type);
	return Array.from(fields, ([name, type]) => ({ name, type }));
}

/** The request an active menu sends and the returned values its screens read. */
function activeSearchMenus(doc: BlueprintDoc) {
	return Object.values(doc.modules).flatMap((module) => {
		const search = effectiveCaseSearchConfig(module)?.projectSearch;
		if (!search || moduleCaseTypeForActions(doc, module.uuid) === "") return [];
		return [
			{
				module,
				search,
				name:
					doc.appSettings.projectSearches?.[search.searchUuid]?.name ??
					module.name,
			},
		];
	});
}

export function projectSearchUses(doc: BlueprintDoc) {
	const menus = activeSearchMenus(doc);
	if (!menus.length) return [];
	const expressionReads = resultExpressionReads(doc);
	return menus.map(({ module, search, name }) => {
		const inputs = module.caseListConfig?.searchInputs ?? [];
		return {
			searchUuid: search.searchUuid,
			name,
			menu: module.name,
			menuUuid: module.uuid,
			parameters: [
				...inputs
					.filter(
						(input) =>
							(input.kind === "parameter" || input.kind === "hidden") &&
							input.sendAnswer,
					)
					.map((input) => input.name),
				...search.defaults.map((parameter) => parameter.name),
			],
			excludesOwners: !!module.caseSearchConfig?.excludedOwnerIds,
			sendsParent: !!(
				moduleFormsReadSearch(module) &&
				module.parentCaseModuleUuid &&
				doc.modules[module.parentCaseModuleUuid]?.caseType
			),
			results: resultFields(doc, module, expressionReads),
		};
	});
}

export function projectSearchDependencies(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, string> {
	return new Map(
		activeSearchMenus(doc).map(({ search, name }) => [search.searchUuid, name]),
	);
}
