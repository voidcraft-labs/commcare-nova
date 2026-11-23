import type { BlueprintDoc } from "./blueprint";
import { caseContextLine, resolveCaseFormContext } from "./caseFormContext";
import { type DetailTab, detailTabSpans } from "./detailTabSchema";
import { effectiveFilterForEmission } from "./expression/simplify";
import type { Expression } from "./expression/types";
import {
	substituteUnansweredSearchInputs,
	walkExpression,
} from "./expression/walk";
import type { LookupTableId } from "./lookupIds";
import {
	type CaseListConfig,
	type Column,
	effectiveCaseSearchConfig,
	type Module,
	moduleFormsReadSearch,
	searchInputDefault,
} from "./modules";
import { isDeeplySettled } from "./settled";
import type { Uuid } from "./uuid";

export {
	type DetailTab,
	type DetailTabRowSource,
	type DetailTabSpan,
	detailTabRowSourceSchema,
	detailTabSchema,
	detailTabSearchChildType,
	detailTabSpans,
	detailTabsSchema,
} from "./detailTabSchema";

/** Relevance belongs to the selected case even when a tab later lists other
 * records. A gated expression is read from the same SQL row as its columns. */
export function availableDetailTabs(
	config: CaseListConfig | undefined,
	columns: readonly Pick<Column, "uuid">[],
	calculated: Readonly<Record<string, unknown>>,
) {
	if (!config?.detailTabs) return undefined;
	return (detailTabSpans(config.detailTabs, columns) ?? []).filter(
		({ tab }) => !tab.displayCondition || calculated[tab.uuid] === true,
	);
}
/** HQ's ordinary menu requires each row origin of its Details tile to belong
 * to one tab. Advanced menus draw the sub-details independently, using the
 * same coordinates in each. See helpers/validators.py::validate_case_tiles. */
export function detailTileSharesRowAcrossTabs(
	config: CaseListConfig | undefined,
): boolean {
	if (!config?.detailTile || !config.detailTabs) return false;
	const starts = new Set(config.detailTabs.map((tab) => tab.startColumnUuid));
	const owners = new Map<number, Uuid>();
	let tab: Uuid | undefined;
	for (const uuid of config.detailColumnOrder) {
		if (starts.has(uuid)) tab = uuid;
		const cell = config.detailTile.cells[uuid];
		if (!cell || !tab) continue;
		const other = owners.get(cell.y);
		if (other && other !== tab) return true;
		owners.set(cell.y, tab);
	}
	return false;
}

/** Which tab supplies the data for a field on Details. A column that is off
 * Details is still evaluated in the ordinary menu's scope. */
export function detailTabForColumn(
	config: CaseListConfig | undefined,
	uuid: Uuid,
) {
	if (!config?.detailTabs) return;
	return detailTabMembership(config).get(uuid);
}

/** A native data tab uses its hidden fields to order rows. Only displayed,
 * unsorted, Details-only cells can observe a value when a worker opens them. */
export function allowsDetailObservation(
	config: CaseListConfig | undefined,
	column: Column,
): boolean {
	return (
		column.kind === "calculated" &&
		column.notOnList === true &&
		column.visibleInDetail !== false &&
		column.sort === undefined &&
		!detailTabForColumn(config, column.uuid)?.orderFields?.includes(column.uuid)
	);
}

const heldMembership = new WeakMap<
	CaseListConfig,
	ReadonlyMap<Uuid, DetailTab>
>();
export function detailTabMembership(
	config: CaseListConfig,
): ReadonlyMap<Uuid, DetailTab> {
	const held = heldMembership.get(config);
	if (held) return held;
	const starts = new Map(
		config.detailTabs?.map((tab) => [tab.startColumnUuid, tab]),
	);
	const shown = new Set(
		config.columns
			.filter((column) => column.visibleInDetail !== false)
			.map((column) => column.uuid),
	);
	let owner: DetailTab | undefined;
	const fields = new Map<Uuid, DetailTab>();
	for (const uuid of config.detailColumnOrder) {
		if (!shown.has(uuid)) continue;
		owner = starts.get(uuid) ?? owner;
		if (owner) fields.set(uuid, owner);
	}
	if (Object.isFrozen(config)) heldMembership.set(config, fields);
	return fields;
}

/** Native fixture reads of a tab's visibility rule. HQ collects the fields
 * and row sources in a detail and the selected datum and search query in an
 * entry; it omits the rule itself. The same long detail can appear on more
 * than one route, including another menu's form. */
type DetailFixture = LookupTableId | "places";
const conditionFixtures = new WeakMap<
	BlueprintDoc,
	Map<Uuid, ReadonlySet<DetailFixture>>
>();

function readFixtures(into: Set<DetailFixture>, value: Expression | undefined) {
	if (!value) return;
	walkExpression(value, {
		visitExpression(node) {
			if (node.kind === "table-lookup" || node.kind === "table-rows")
				into.add(node.tableId);
			if (node.kind === "locations") into.add("places");
		},
		visitTerm(term) {
			if (term.kind === "owner-location-at-level") into.add("places");
		},
	});
}

function screenFixtures(
	menu: Module,
	screen: "short" | "long",
	into: Set<DetailFixture>,
) {
	const config = menu.caseListConfig;
	if (!config) return;
	for (const column of config.columns) {
		const active =
			screen === "long"
				? column.visibleInDetail !== false
				: !column.notOnList && (column.visibleInList !== false || !config.tile);
		if (active && column.kind === "calculated")
			readFixtures(into, column.expression);
	}
	if (screen === "long")
		for (const tab of config.detailTabs ?? []) {
			const source = tab.rowSource;
			readFixtures(
				into,
				source?.kind === "records" ? source.rows : source?.condition,
			);
		}
}

function queryFixtures(menu: Module, into: Set<DetailFixture>) {
	for (const input of menu.caseListConfig?.searchInputs ?? []) {
		if (input.kind === "hidden") {
			readFixtures(into, input.value);
			continue;
		}
		if ("options" in input) {
			into.add(input.options.tableId);
			readFixtures(into, input.options.filter);
		}
		readFixtures(into, searchInputDefault(input));
		readFixtures(into, input.required?.when);
		readFixtures(into, input.validation?.rule);
	}
}

function detailRouteFixtures(
	doc: BlueprintDoc,
	owner: Module,
	choosing: Module,
	remote: boolean,
) {
	const found = new Set<DetailFixture>();
	screenFixtures(owner, "long", found);
	screenFixtures(choosing, "short", found);
	if (remote || moduleFormsReadSearch(choosing)) queryFixtures(choosing, found);
	if (!remote) {
		const filter = choosing.caseListConfig?.filter;
		if (filter)
			readFixtures(
				found,
				effectiveFilterForEmission(substituteUnansweredSearchInputs(filter)),
			);
		const excluded = choosing.caseSearchConfig?.excludedOwnerIds;
		if (excluded)
			readFixtures(found, substituteUnansweredSearchInputs(excluded));
		const formContext = resolveCaseFormContext(doc.modules, choosing.uuid);
		const header = formContext && doc.modules[formContext.sourceModuleUuid];
		if (header && formContext?.kind === "tile")
			screenFixtures(header, "short", found);
		if (header && formContext?.kind === "line")
			readFixtures(
				found,
				caseContextLine(header.caseListConfig?.contextAboveForm),
			);
	}
	return found;
}

export function detailConditionFixtures(
	doc: BlueprintDoc,
	owner: Module,
): ReadonlySet<DetailFixture> {
	const known = conditionFixtures.get(doc)?.get(owner.uuid);
	if (known) return known;
	const common = detailRouteFixtures(doc, owner, owner, false);
	const intersect = (other: ReadonlySet<DetailFixture>) => {
		for (const item of common) if (!other.has(item)) common.delete(item);
	};
	if (effectiveCaseSearchConfig(owner) && !moduleFormsReadSearch(owner))
		intersect(detailRouteFixtures(doc, owner, owner, true));
	for (const choosing of Object.values(doc.modules)) {
		if (
			choosing.uuid !== owner.uuid &&
			resolveCaseFormContext(doc.modules, choosing.uuid)?.inlineModuleUuid ===
				owner.uuid
		)
			intersect(detailRouteFixtures(doc, owner, choosing, false));
	}
	if (isDeeplySettled(doc)) {
		const held = conditionFixtures.get(doc) ?? new Map();
		held.set(owner.uuid, common);
		conditionFixtures.set(doc, held);
	}
	return common;
}
