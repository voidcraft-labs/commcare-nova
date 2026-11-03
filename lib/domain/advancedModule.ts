// lib/domain/advancedModule.ts
//
// What keeps a menu from being an advanced module in CommCare HQ, and the
// one index name an advanced form's chained loads follow. Nova never offers
// an advanced menu as a choice: a menu is emitted advanced only where its
// kind is held (`Module.heldKind`) or a create an after-submit link carries
// needs it (`lib/commcare/moduleKind.ts::emittedModuleKind`), and only where
// none of these blockers holds. The blockers stay in the domain because the
// builder and the commit gate read them, and both restate wire facts in
// domain terms; `lib/commcare` reads them, never the reverse.

import type { BlueprintDoc } from "./blueprint";
import { rootSelectionAlignment } from "./entryDatumSupplies";
import { effectiveFilterForEmission } from "./expression/simplify";
import { substituteUnansweredSearchInputs } from "./expression/walk";
import { operationCaseType } from "./forms";
import {
	caseSelectionCardinality,
	moduleFormsReadSearch,
	moduleHasCaseListMenuItem,
} from "./modules";
import type { Uuid } from "./uuid";

/**
 * One reason a menu cannot be an advanced module, each a case HQ's
 * advanced entry would show differently from the ordinary one:
 *
 * - `several-cases`: the menu lets a worker choose several cases. HQ's
 *   advanced entry asks for one (`AdvancedModule.is_multi_select` is false).
 * - `forms-read-search`: the menu's forms read the search
 *   (`caseSearchConfig.formsReadSearch`). HQ's advanced entry adds no query datum
 *   (`entries.py::configure_entry_advanced_form`).
 * - `case-list-menu-item-narrowed`: the menu has its case list as a menu
 *   item, and that list is narrowed by a filter (`filter`), by hidden
 *   owners (`hidden-owners`), or by a case chosen before it
 *   (`chosen-before`). HQ's advanced menu item lists every open case of the
 *   type (`entries.py::entry_for_module`).
 * - `chain-index`: the menu selects a parent case, and the app links one
 *   pair of its chain's case types under more than one index name. HQ's
 *   advanced load follows one index by name
 *   (`entries.py::get_parent_filter_by_ref_id`).
 */
export type AdvancedKindBlocker =
	| { readonly kind: "several-cases" }
	| { readonly kind: "forms-read-search" }
	| {
			readonly kind: "case-list-menu-item-narrowed";
			readonly why: "filter" | "hidden-owners" | "chosen-before";
	  }
	| {
			readonly kind: "chain-index";
			readonly childType: string;
			readonly parentType: string;
			readonly identifiers: readonly string[];
	  };

/**
 * The index name a chained load follows from a case of `childType` to the
 * one of `parentType` it was chosen under: the one identifier the app's
 * child links between the two types use, or `parent` where none does
 * (HQ's own name for a basic subcase's index, `xform.py::_create_casexml`
 * writes `reference_id or 'parent'`). `several` is a chain no one name
 * follows, the `chain-index` blocker.
 */
export type ChainIndex =
	| { readonly kind: "one"; readonly identifier: string }
	| { readonly kind: "several"; readonly identifiers: readonly string[] };

/** Every child link's identifiers, by `(childType, parentType)` pair, in
 *  document order, deduplicated. Memoized per document object. */
const childLinkIdentifiers = new WeakMap<
	BlueprintDoc,
	ReadonlyMap<string, readonly string[]>
>();

function pairKey(childType: string, parentType: string): string {
	return JSON.stringify([childType, parentType]);
}

function childLinkIdentifiersOf(
	doc: BlueprintDoc,
): ReadonlyMap<string, readonly string[]> {
	const cached = childLinkIdentifiers.get(doc);
	if (cached !== undefined) return cached;
	const byPair = new Map<string, string[]>();
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			for (const operation of doc.forms[formUuid]?.caseOperations ?? []) {
				const links = operation.links ?? [];
				if (links.length === 0) continue;
				const childType = operationCaseType(doc, formUuid, operation);
				if (childType === undefined) continue;
				for (const link of links) {
					if (link.relationship !== "child") continue;
					const key = pairKey(childType, link.targetType);
					const identifiers = byPair.get(key);
					if (identifiers === undefined) byPair.set(key, [link.identifier]);
					else if (!identifiers.includes(link.identifier))
						identifiers.push(link.identifier);
				}
			}
		}
	}
	childLinkIdentifiers.set(doc, byPair);
	return byPair;
}

/**
 * The index name an advanced load of a `childType` case chained to a
 * `parentType` load follows: every link of every case operation in the app
 * (a create's, an update's, a form's own case's) from `childType` to
 * `parentType` with relationship `child`, by identifier, deduplicated in
 * document order. Extension links are not counted: a parent selection
 * lists children, never extensions.
 */
export function advancedChainIndex(
	doc: BlueprintDoc,
	childType: string,
	parentType: string,
): ChainIndex {
	const identifiers =
		childLinkIdentifiersOf(doc).get(pairKey(childType, parentType)) ?? [];
	if (identifiers.length === 0) return { kind: "one", identifier: "parent" };
	if (identifiers.length === 1)
		return { kind: "one", identifier: identifiers[0] };
	return { kind: "several", identifiers: [...identifiers] };
}

/** The modules of `moduleUuid`'s parent selection, root first, ending at
 *  `moduleUuid`. A cycle, which the validator refuses, ends the walk. */
function parentSelectionChain(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly Uuid[] {
	const chain: Uuid[] = [moduleUuid];
	const seen = new Set<Uuid>([moduleUuid]);
	let current = doc.modules[moduleUuid]?.parentCaseModuleUuid;
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		chain.unshift(current);
		current = doc.modules[current]?.parentCaseModuleUuid;
	}
	return chain;
}

/** How the menu's own case list, shown as a menu item, is narrowed, the
 *  first of filter, hidden owners and a case chosen before it; `undefined`
 *  where it lists every open case of its type. */
function caseListNarrowing(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): "filter" | "hidden-owners" | "chosen-before" | undefined {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return undefined;
	const filter = module.caseListConfig?.filter;
	if (
		filter !== undefined &&
		effectiveFilterForEmission(substituteUnansweredSearchInputs(filter)) !==
			undefined
	)
		return "filter";
	if (module.caseSearchConfig?.excludedOwnerIds !== undefined)
		return "hidden-owners";
	if (
		module.parentCaseModuleUuid !== undefined ||
		rootSelectionAlignment(doc, { kind: "browse", module: moduleUuid }).matches
			.length > 0
	)
		return "chosen-before";
	return undefined;
}

/**
 * What keeps `moduleUuid` from being an advanced module, in the order
 * `several-cases`, `forms-read-search`, `case-list-menu-item-narrowed`,
 * `chain-index`, each at most once. Empty where nothing does.
 */
export function advancedKindBlockers(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly AdvancedKindBlocker[] {
	const module = doc.modules[moduleUuid];
	if (module === undefined) return [];
	const blockers: AdvancedKindBlocker[] = [];
	if (caseSelectionCardinality(module) === "multiple")
		blockers.push({ kind: "several-cases" });
	if (moduleFormsReadSearch(module))
		blockers.push({ kind: "forms-read-search" });
	if (moduleHasCaseListMenuItem(module)) {
		const why = caseListNarrowing(doc, moduleUuid);
		if (why !== undefined)
			blockers.push({ kind: "case-list-menu-item-narrowed", why });
	}
	if (module.parentCaseModuleUuid !== undefined) {
		const chain = parentSelectionChain(doc, moduleUuid);
		for (let i = 1; i < chain.length; i++) {
			const parentType = doc.modules[chain[i - 1]]?.caseType;
			const childType = doc.modules[chain[i]]?.caseType;
			if (parentType === undefined || childType === undefined) continue;
			const index = advancedChainIndex(doc, childType, parentType);
			if (index.kind === "several") {
				blockers.push({
					kind: "chain-index",
					childType,
					parentType,
					identifiers: index.identifiers,
				});
				break;
			}
		}
	}
	return blockers;
}

/**
 * Whether a held advanced kind still expresses the menu: no blocker holds.
 * The `module-kind` target of `holdPlacements` reads it, and so does the
 * gate's `HELD_PLACEMENT_INEXPRESSIBLE` arm for a menu.
 */
export function heldKindExpresses(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	return advancedKindBlockers(doc, moduleUuid).length === 0;
}
