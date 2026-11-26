import { searchInputGroupsWithMembers } from "@/lib/domain";
import {
	type LookupRead,
	lookupReadType,
	lookupReadTypes,
} from "@/lib/domain/lookupRead";
import {
	caseTextKeyVariants,
	caseTextWireKey,
} from "../suite/case-list/calculationText";
import { mappingIdentityAt } from "./caseList/mappingIdentity";
// lib/commcare/reader/identityMap.ts
//
// The projection of a Nova document onto the external keys a reading of its
// CommCare HQ app would mint under: every entity of a kind HQ's app holds,
// with the key `identity.ts::externalKey` spells for it and the UUID the
// document gives it. Handed to `matchingResolver`, it makes a reading of the
// app give back the document's own UUIDs. It is computed wherever it is
// needed and stored nowhere.

import {
	type BasicPlacement,
	type BlueprintDoc,
	type CaseOperation,
	type CasePlacement,
	type Form,
	type FormLinkTarget,
	formLinkEntries,
	orderedColumns,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import {
	caseMappingComparison,
	caseMappingRowUuid,
} from "@/lib/domain/caseMappingRows";
import { detailTabMembership } from "@/lib/domain/detailTabs";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	type FormStructure,
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { ownedFormSelections } from "@/lib/domain/formEntryCases";
import { openingAssignmentSource } from "@/lib/domain/formOpeningAssignments";
import {
	isDedicatedOwnerFilter,
	moduleFormsReadSearch,
	parentPathSearchRequestKey,
	projectSearchOf,
	searchInputRequestKey,
} from "@/lib/domain/modules";
import type { LookupTableId } from "@/lib/lookup/types";
import { moduleExpressionContexts } from "../expressionContext";
import type { LookupWireNaming } from "../lookup/naming";
import { planPlacements } from "../placement";
import { mappingCondition } from "../suite/case-list/mappingCondition";
import {
	hqCalculatedSortExpression,
	hqExpressionField,
} from "../suite/case-list/orderPlanOptions";
import { searchRequestKey } from "../suite/case-search/nativeFilters";
import { installationProfileKey, type WireIdentity } from "../wireIdentity";
import { w } from "../xpath/wire/builders";
import { serializeWire } from "../xpath/wire/serialize";
import { calculatedAttributeField } from "./caseList/attributeColumns";
import { storedColumnKind } from "./caseList/columnIdentity";
import {
	type CaseOperationPlaceKey,
	type ExternalKey,
	externalKey,
	externalKeyText,
	type FormLinkTargetKey,
	type IdentityMapEntry,
	matchingUuidOf,
	sharedFormKey,
	sortIdentityMapEntries,
} from "./identity";
import { recordSyntaxKey } from "./syntaxCompare";

/**
 * The UUID a re-read of `doc`'s export gives an entity of `key`, told
 * `externalIdentityMap(doc, identity)` through `matchingResolver`: the
 * document's own UUID where it holds the key, else a UUID it holds under no
 * key (`identity.ts::freeEntityUuid`). A canonical row that gives an entity
 * the UUID a re-read gives it asks here, never `mintEntityUuid` directly: a
 * document holds an entity renamed in Nova (a column whose property changed,
 * an ordinal a removal moved) under the UUID its old key mints, and a re-read
 * gives a new entity of that old key another one. The map is built on the
 * first call.
 */
export function reReadUuidOf(
	doc: BlueprintDoc,
	identity: WireIdentity,
): (key: ExternalKey) => Uuid {
	let uuidOf: ((key: ExternalKey) => Uuid) | undefined;
	return (key) => {
		uuidOf ??= matchingUuidOf(doc.appId, externalIdentityMap(doc, identity));
		return uuidOf(key);
	};
}

/** A fresh HQ inventory can have lost a table since the accepted comparison
 * document was saved. Such a rule has no current wire spelling. Reserve its
 * identity so a different HQ rule cannot inherit it during review. */
function canNameCalculation(
	expression: Expression,
	naming: LookupWireNaming,
): boolean {
	let available = true;
	const check = (tableId: LookupTableId, read?: LookupRead) => {
		const table = naming.maybeTableFor(tableId);
		if (
			!table ||
			(read !== undefined &&
				lookupReadType(lookupReadTypes(table), read) === undefined)
		)
			available = false;
	};
	walkExpression(expression, {
		visitTerm(term) {
			if (term.kind === "table-column") check(term.tableId, term.columnId);
		},
		visitExpression(node) {
			if (node.kind === "table-lookup")
				check(node.tableId, node.resultColumnId);
			if (node.kind === "table-rows") check(node.tableId);
		},
	});
	return available;
}

/**
 * Every entity of `doc` that has an external key, with that key, ordered by
 * `externalKeyText`.
 *
 * Total over a document the commit gate admits: it reads no store. A menu the emission plan adds is not an entity and has no
 * entry. Ids are unique among siblings, option values within a select and
 * input names within a module, and the ordinal kinds count among equals, so
 * no two entities of an admitted document share a key; a document that holds
 * two (two worker properties of one slug, say) is refused here rather than
 * mapped to one of them.
 */
/** Nova keeps the display/editor name, while HQ keeps the parent request key. */
export function knownParentPathSearchNamesOf(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, string> {
	return new Map(
		Object.values(doc.modules).flatMap((module) =>
			(module.caseListConfig?.searchInputs ?? []).flatMap((input) =>
				parentPathSearchRequestKey(input) === undefined
					? []
					: [[input.uuid, input.name] as const],
			),
		),
	);
}

export function externalIdentityMap(
	doc: BlueprintDoc,
	identity: WireIdentity,
	lookupNaming?: LookupWireNaming,
): readonly IdentityMapEntry[] {
	const entries: IdentityMapEntry[] = [];
	const add = (key: ExternalKey, uuid: Uuid): void => {
		entries.push({ kind: key.kind, parts: key.parts, uuid });
	};

	for (const uuid of Object.keys(
		doc.appSettings.projectSearches ?? {},
	) as Uuid[]) {
		const endpointId = identity.projectSearchId?.(uuid);
		if (endpointId !== undefined)
			add(externalKey.projectSearch(endpointId), uuid);
	}
	for (const profile of Object.values(
		doc.appSettings.installationProfiles ?? {},
	)) {
		add(
			externalKey.installationProfile(
				installationProfileKey(profile.uuid, identity),
			),
			profile.uuid,
		);
	}
	const caseTypes = effectiveCaseTypes(doc);
	for (const module of Object.values(doc.modules)) {
		const uniqueId = identity.moduleUniqueId(module.uuid);
		add(externalKey.module(uniqueId), module.uuid);
		if (module.entryPoint)
			add(
				externalKey.entryPoint("module", uniqueId, "menu"),
				module.entryPoint.uuid,
			);
		if (module.caseListEntryPoint)
			add(
				externalKey.entryPoint("module", uniqueId, "case-list"),
				module.caseListEntryPoint.uuid,
			);
		for (const { formUuid, entryPoint: endpoint } of module.formsFromMenu
			?.entryPoints ?? []) {
			const form = doc.forms[formUuid];
			if (form)
				add(
					externalKey.entryPoint(
						"shared-form",
						uniqueId,
						identity.formXmlns(form),
					),
					endpoint.uuid,
				);
		}
		const occurrences = new Map<string, number>();
		for (const parameter of projectSearchOf(module)?.defaults ?? [])
			add(
				externalKey.projectSearchParameter(
					uniqueId,
					parameter.name,
					nextOrdinal(occurrences, parameter.name),
				),
				parameter.uuid,
			);
		const config = module.caseListConfig;
		if (config !== undefined) {
			if (config.calculatedSorts?.length) {
				const expressions = moduleExpressionContexts(
					doc,
					module.uuid,
					lookupNaming,
				);
				const counts = new Map<string, number>();
				for (const rule of config.calculatedSorts) {
					if (
						lookupNaming &&
						!canNameCalculation(rule.expression, lookupNaming)
					) {
						add(
							externalKey.caseListSort(
								uniqueId,
								JSON.stringify(["unavailable-table", rule.uuid]),
								0,
							),
							rule.uuid,
						);
						continue;
					}
					const wire = hqCalculatedSortExpression(
						rule,
						module,
						doc,
						expressions,
						lookupNaming,
					);
					const text = serializeWire(wire, {
						target: "hq-json",
						interpolation: "none",
					}).text;
					const key = recordSyntaxKey(text);
					add(
						externalKey.caseListSort(uniqueId, key, nextOrdinal(counts, key)),
						rule.uuid,
					);
				}
			}
			const membership = config.detailTabs && detailTabMembership(config);
			const tabColumns = new Map<Uuid, ExternalKey[]>();
			const columnCounts = new Map<string, number>();
			for (const column of orderedColumns(config, "list")) {
				// A calculated column that reads one attribute alone is read as the
				// plain column over it (`caseList/attributeColumns.ts`).
				const attribute = calculatedAttributeField(column, module.caseType);
				const kind =
					attribute === undefined
						? storedColumnKind(column, module.caseType, caseTypes)
						: "plain";
				const field =
					attribute ?? (column.kind === "calculated" ? "" : column.field);
				const n = nextOrdinal(columnCounts, JSON.stringify([kind, field]));
				const key = externalKey.caseListColumn(uniqueId, kind, field, n);
				add(key, column.uuid);
				const tab = membership?.get(column.uuid);
				if (tab !== undefined) {
					const group = tabColumns.get(tab.uuid);
					if (group) group.push(key);
					else tabColumns.set(tab.uuid, [key]);
				}
				if (column.kind === "calculated" && column.texts?.length) {
					const namable =
						!lookupNaming ||
						canNameCalculation(column.expression, lookupNaming);
					const variants = namable
						? caseTextKeyVariants(
								hqExpressionField(column, module, doc, "results", lookupNaming),
								column.texts,
							)
						: undefined;
					for (const piece of column.texts)
						add(
							namable
								? externalKey.caseCalculationText(
										column.uuid,
										caseTextWireKey(piece.uuid, variants?.get(piece.uuid)),
									)
								: externalKey.caseMappingRow(
										column.uuid,
										JSON.stringify([
											"unavailable-calculation-text",
											piece.uuid,
										]),
									),
							piece.uuid,
						);
				}
				if (column.kind === "image-map" || column.kind === "id-mapping") {
					const counts = new Map<string, number>();
					for (const row of column.mapping) {
						const uuid = caseMappingRowUuid(column.uuid, row);
						let comparison = caseMappingComparison(row);
						if (row.when) {
							if (lookupNaming && !canNameCalculation(row.when, lookupNaming))
								comparison = JSON.stringify(["unavailable-table", uuid]);
							else {
								const wire = mappingCondition(
									column.uuid,
									row,
									w.context([w.self()]),
									{
										expressions: moduleExpressionContexts(
											doc,
											module.uuid,
											lookupNaming,
										),
										lookupNaming,
										inline: moduleFormsReadSearch(module),
									},
									"hq-json",
								);
								comparison = JSON.stringify([
									"condition",
									recordSyntaxKey(
										serializeWire(wire, {
											target: "hq-json",
											interpolation: "enum-key",
										}).text,
									),
								]);
							}
						}
						add(
							externalKey.caseMappingRow(
								column.uuid,
								mappingIdentityAt(comparison, counts),
							),
							uuid,
						);
					}
				}
			}
			for (const [tabUuid, [first, ...others]] of tabColumns)
				if (first) add(externalKey.caseDetailTab(first, others), tabUuid);
			const filterCounts = new Map<string, number>();
			for (const filter of config.searchFilters ?? []) {
				// The dedicated owner exclusion is no default filter: its key
				// names the setting, not its request key's place among them.
				const key = isDedicatedOwnerFilter(filter)
					? "search-setting:excluded-owners"
					: searchRequestKey(filter);
				add(
					externalKey.searchFilter(
						uniqueId,
						key,
						nextOrdinal(filterCounts, key),
					),
					filter.uuid,
				);
			}
			for (const [position, group] of searchInputGroupsWithMembers(
				config,
			).entries())
				add(
					externalKey.searchInputGroup(
						uniqueId,
						group.inputs.map(({ name }) => name),
						position,
					),
					group.uuid,
				);
			for (const input of config.searchInputs)
				add(
					externalKey.searchInput(uniqueId, searchInputRequestKey(input)),
					input.uuid,
				);
		}
	}

	for (const form of Object.values(doc.forms)) {
		const xmlns = identity.formXmlns(form);
		const entryKey = form.shadowOf
			? sharedFormKey(identity.formUniqueId(form.uuid))
			: xmlns;
		add(externalKey.form(entryKey), form.uuid);
		if (form.entryPoint)
			add(externalKey.entryPoint("form", entryKey), form.entryPoint.uuid);
		const structure = formStructure(doc, form.uuid);
		if (structure === undefined)
			throw new Error(
				`Nova could not map form ${form.uuid} to the keys a reading of its CommCare HQ app gives: no menu lists it. A document the commit gate admits lists every form in one menu.`,
			);
		for (const field of structure.fields.values()) {
			const path = authoredPath(structure, field.uuid);
			add(externalKey.field(xmlns, path), field.uuid);
			if (field.choices?.kind === "inline")
				for (const option of field.choices.options)
					add(externalKey.selectOption(xmlns, path, option.value), option.uuid);
		}
		if (!form.caseSelections && !form.shadowOf)
			for (const [uuid, tag] of Object.entries(form.heldSelectionTags ?? {}))
				add(externalKey.formSelection(form.uuid, tag), uuid as Uuid);
		for (const assignment of form.openingAssignments ?? []) {
			const { key: source } = openingAssignmentSource(
				doc,
				form.uuid,
				assignment.source,
			);
			add(
				externalKey.openingAssignment(form.uuid, source, assignment.field),
				assignment.uuid,
			);
		}
		for (const row of ownedFormSelections(form))
			add(externalKey.formSelection(form.uuid, row.tag), row.uuid);
		for (const row of form.computedDatums ?? [])
			add(externalKey.entryValue(form.uuid, row.key), row.uuid);
		addCaseOperations(doc, form, xmlns, structure, add);
		const linkCounts = new Map<string, number>();
		for (const { link } of formLinkEntries(form)) {
			const target = linkTargetKey(doc, identity, link.target);
			const n = nextOrdinal(linkCounts, JSON.stringify(target));
			add(externalKey.formLink(entryKey, target, n), link.uuid);
		}
	}

	for (const property of Object.values(doc.userProperties ?? {}))
		add(externalKey.userProperty(property.slug), property.uuid);
	for (const level of Object.values(doc.organizationLevels ?? {}))
		add(externalKey.organizationLevel(level.code), level.uuid);
	for (const property of Object.values(doc.locationProperties ?? {}))
		add(externalKey.locationProperty(property.slug), property.uuid);

	const seen = new Set<string>();
	for (const entry of entries) {
		const text = externalKeyText(entry);
		if (seen.has(text))
			throw new Error(
				`Nova could not map the document to the keys a reading of its CommCare HQ app gives: two of its entities share one ${entry.kind} key, so a reading could not tell them apart. A document the commit gate admits holds no two entities of one key; look at the document's ${entry.kind} entities.`,
			);
		seen.add(text);
	}
	return sortIdentityMapEntries(entries);
}

/** The next 0-based ordinal of `equalityKey` among the entities counted so far. */
function nextOrdinal(counts: Map<string, number>, equalityKey: string): number {
	const n = counts.get(equalityKey) ?? 0;
	counts.set(equalityKey, n + 1);
	return n;
}

function authoredPath(structure: FormStructure, uuid: Uuid): readonly string[] {
	const path = formFieldPath(structure, uuid);
	if (path === undefined)
		throw new Error(
			`Nova could not find the path of question ${uuid} in form ${structure.formUuid}. Every question of a form the commit gate admits sits on a path from the form's root.`,
		);
	return path;
}

function addCaseOperations(
	doc: BlueprintDoc,
	form: Form,
	xmlns: string,
	structure: FormStructure,
	add: (key: ExternalKey, uuid: Uuid) => void,
): void {
	const operations = form.caseOperations ?? [];
	if (operations.length === 0) return;
	const { placements } = planPlacements(doc, form.uuid);
	const counts = new Map<string, number>();
	for (const operation of operations) {
		const planned = placements.get(operation.uuid);
		if (planned === undefined)
			throw new Error(
				`Nova found no place for case operation ${operation.uuid} of form ${form.uuid}. The plan of a form's case changes places every operation.`,
			);
		const place = placeKey(structure, operation, planned.placement);
		const n = nextOrdinal(counts, JSON.stringify([place, operation.action]));
		add(
			externalKey.caseOperation(xmlns, place, operation.action, n),
			operation.uuid,
		);
	}
}

/** A case operation's `place`, from the placement it takes. */
function placeKey(
	structure: FormStructure,
	operation: CaseOperation,
	placement: CasePlacement,
): CaseOperationPlaceKey {
	switch (placement.kind) {
		case "basic":
			return basicPlaceKey(structure, operation, placement);
		case "advanced":
			return ["advanced", placement.tag];
		case "save-to-case":
			return [
				"save-to-case",
				placement.repeat === undefined
					? []
					: authoredPath(structure, placement.repeat),
				placement.path,
			];
	}
}

function basicPlaceKey(
	structure: FormStructure,
	operation: CaseOperation,
	placement: BasicPlacement,
): CaseOperationPlaceKey {
	switch (placement.slot) {
		case "own":
			return ["basic", "own"];
		case "usercase":
			return ["basic", "usercase"];
		case "subcase":
			return ["basic", "subcase", placement.index];
		case "subcase-row": {
			const repeat = operation.forEach?.repeat;
			if (repeat === undefined)
				throw new Error(
					`Nova placed case operation ${operation.uuid} in a repeat's row, and it runs in no repeat. A row's subcase is a create that runs per row.`,
				);
			return ["basic", "subcase-row", authoredPath(structure, repeat)];
		}
	}
}

function linkTargetKey(
	doc: BlueprintDoc,
	identity: WireIdentity,
	target: FormLinkTarget,
): FormLinkTargetKey {
	switch (target.type) {
		case "form": {
			const targetForm = ownRecordValue(doc.forms, target.formUuid);
			if (targetForm === undefined)
				throw new Error(
					`Nova could not map an after-submit link to form ${target.formUuid}: the document holds no such form. A document the commit gate admits links only to its own forms.`,
				);
			return [
				"form",
				targetForm.shadowOf
					? sharedFormKey(identity.formUniqueId(targetForm.uuid))
					: identity.formXmlns(targetForm),
			];
		}
		case "module":
			return ["module", identity.moduleUniqueId(target.moduleUuid)];
		case "this-form":
			return ["this-form"];
	}
}
