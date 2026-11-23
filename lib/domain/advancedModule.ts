// lib/domain/advancedModule.ts
//
// What keeps a menu from being an advanced module in CommCare HQ, the one
// index name an advanced form's chained loads follow, and the index a form's
// read of an ancestor case follows from each case to its parent. Nova never offers
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

/** One case operation's links between one pair of case types: the
 *  identifiers it writes to a case with a target, whatever their
 *  relationship, and whether the operation creates the case it links. */
interface PairLinking {
	readonly identifiers: readonly string[];
	readonly creates: boolean;
}

/** What the app's case operations write between one pair of case types. */
interface PairFacts {
	/** Each operation that links the pair, in document order. */
	readonly linkings: readonly PairLinking[];
	/** Each identifier a link with no target removes from the case. */
	readonly removed: ReadonlySet<string>;
	/** Each identifier's relationship, from the first link that writes it,
	 *  a creating operation's first. */
	readonly relationships: ReadonlyMap<string, "child" | "extension">;
}

/** Every pair's facts by `(childType, parentType)` pair, and the number of
 *  operations that create a case of each type (a registration form's own
 *  case, whether or not it holds its own arm, and every create). Memoized
 *  per document object. */
interface LinkFacts {
	readonly pairs: ReadonlyMap<string, PairFacts>;
	readonly creates: ReadonlyMap<string, number>;
}

const linkFacts = new WeakMap<BlueprintDoc, LinkFacts>();

function linkFactsOf(doc: BlueprintDoc): LinkFacts {
	const cached = linkFacts.get(doc);
	if (cached !== undefined) return cached;
	const pairs = new Map<
		string,
		{
			linkings: PairLinking[];
			removed: Set<string>;
			relationships: Map<string, "child" | "extension">;
			created: Map<string, "child" | "extension">;
		}
	>();
	const creates = new Map<string, number>();
	const pairOf = (key: string) => {
		let pair = pairs.get(key);
		if (pair === undefined) {
			pair = {
				linkings: [],
				removed: new Set(),
				relationships: new Map(),
				created: new Map(),
			};
			pairs.set(key, pair);
		}
		return pair;
	};
	for (const moduleUuid of doc.moduleOrder) {
		const moduleType = doc.modules[moduleUuid]?.caseType;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			const registration = form.type === "registration";
			// A registration creates its menu's case even where it holds no
			// own arm, and that case carries no link.
			if (
				registration &&
				moduleType !== undefined &&
				!form.caseOperations?.some((operation) => operation.action === "own")
			)
				creates.set(moduleType, (creates.get(moduleType) ?? 0) + 1);
			for (const operation of form.caseOperations ?? []) {
				const childType = operationCaseType(doc, formUuid, operation);
				if (childType === undefined) continue;
				const creating =
					operation.action === "create" ||
					(operation.action === "own" && registration);
				if (creating) creates.set(childType, (creates.get(childType) ?? 0) + 1);
				const byTarget = new Map<string, string[]>();
				for (const link of operation.links ?? []) {
					const pair = pairOf(pairKey(childType, link.targetType));
					if (link.target === null) {
						pair.removed.add(link.identifier);
						continue;
					}
					const order = creating ? pair.created : pair.relationships;
					if (!order.has(link.identifier))
						order.set(link.identifier, link.relationship);
					const identifiers = byTarget.get(link.targetType);
					if (identifiers === undefined)
						byTarget.set(link.targetType, [link.identifier]);
					else if (!identifiers.includes(link.identifier))
						identifiers.push(link.identifier);
				}
				for (const [targetType, identifiers] of byTarget)
					pairOf(pairKey(childType, targetType)).linkings.push({
						identifiers,
						creates: creating,
					});
			}
		}
	}
	const facts: LinkFacts = {
		pairs: new Map(
			[...pairs].map(([key, pair]) => [
				key,
				{
					linkings: pair.linkings,
					removed: pair.removed,
					relationships: new Map([...pair.relationships, ...pair.created]),
				},
			]),
		),
		creates,
	};
	linkFacts.set(doc, facts);
	return facts;
}

/**
 * The index a form's read of an ancestor case (`#<type>/<property>`) walks
 * from a `childType` case to its `parentType` case, the type's `parent_type`
 * in the catalog. A read walks an index by its identifier whatever its
 * relationship, so a child link and an extension link (whose host CommCare
 * HQ's own convention names `host`, `casexml/apps/case/const.py::
 * DEFAULT_CASE_INDEX_IDENTIFIERS`) count alike.
 *
 * A name is on every case the app links between the two types where no
 * operation removes it and every operation that links them writes it, or,
 * for an operation that does not create its case, every operation that
 * creates a `childType` case writes it (so every case it can link already
 * holds it); a create that links nothing to `parentType` writes no name.
 *
 * - `one`: where the app names one, that name; where no link joins them,
 *   `parent`, HQ's own name for a subcase's index
 *   (`xform.py::_create_casexml`). Where the app names several: the one
 *   name its child links use (`advancedChainIndex`, the name a parent
 *   selection of an advanced menu lists a `childType` case under, and the
 *   only one a basic parent selection lists it under), so a form reads the
 *   case a worker chose it under; where its child links use none or
 *   several, a name on every such case, `parent` first, then the first in
 *   document order.
 * - `several`: no one name is on every such case (`why: "no-name"`), or
 *   the one name the child links use is not (`why: "child-name"`), so a
 *   read through any one name reads blank for some cases, or reads a case
 *   other than the one a worker chose
 *   (`FORM_CASE_READ_ACROSS_SEVERAL_LINKS` refuses the read).
 */
export type AncestorWalk =
	| {
			readonly kind: "one";
			readonly identifier: string;
			/** The relationship the app's links under `identifier` state,
			 *  `undefined` where no link of the app writes it. */
			readonly relationship: "child" | "extension" | undefined;
	  }
	| {
			readonly kind: "several";
			readonly identifiers: readonly string[];
			readonly why:
				| { readonly kind: "no-name" }
				| { readonly kind: "child-name"; readonly identifier: string };
	  };

export function ancestorWalk(
	doc: BlueprintDoc,
	childType: string,
	parentType: string,
): AncestorWalk {
	const facts = linkFactsOf(doc);
	const pair = facts.pairs.get(pairKey(childType, parentType));
	const linkings = pair?.linkings ?? [];
	const names: string[] = [];
	for (const linking of linkings)
		for (const identifier of linking.identifiers)
			if (!names.includes(identifier)) names.push(identifier);
	const one = (identifier: string): AncestorWalk => ({
		kind: "one",
		identifier,
		relationship: pair?.relationships.get(identifier),
	});
	if (pair === undefined || names.length === 0) return one("parent");
	if (names.length === 1) return one(names[0]);
	const createCount = facts.creates.get(childType) ?? 0;
	const everyCreateWrites = (name: string) =>
		createCount > 0 &&
		linkings.filter(
			(linking) => linking.creates && linking.identifiers.includes(name),
		).length === createCount;
	const onEveryCase = (name: string) =>
		!pair.removed.has(name) &&
		linkings.every(
			(linking) =>
				linking.identifiers.includes(name) ||
				(!linking.creates && everyCreateWrites(name)),
		);
	const chain = advancedChainIndex(doc, childType, parentType);
	if (chain.kind === "one" && names.includes(chain.identifier))
		return onEveryCase(chain.identifier)
			? one(chain.identifier)
			: {
					kind: "several",
					identifiers: names,
					why: { kind: "child-name", identifier: chain.identifier },
				};
	const common = names.filter(onEveryCase);
	if (common.length === 0)
		return { kind: "several", identifiers: names, why: { kind: "no-name" } };
	return one(common.includes("parent") ? "parent" : common[0]);
}

/**
 * The identifier `ancestorWalk` gives, the one a form's read of the parent
 * prints and Nova's own rows name a sample or supplied child's parent by;
 * `parent` where no one name walks to every case, a walk the commit gate
 * refuses every read of.
 */
export function ancestorIndex(
	doc: BlueprintDoc,
	childType: string,
	parentType: string,
): string {
	const walk = ancestorWalk(doc, childType, parentType);
	return walk.kind === "one" ? walk.identifier : "parent";
}

/**
 * The index Nova's own rows name a sample or supplied `childType` case's
 * `parentType` parent by, with its relationship: `ancestorIndex`'s name,
 * under the relationship the app's links under that name state, or the
 * catalog's (`fallback`) where no link of the app writes it.
 */
export function ancestorLink(
	doc: BlueprintDoc,
	childType: string,
	parentType: string,
	fallback: "child" | "extension",
): {
	readonly identifier: string;
	readonly relationship: "child" | "extension";
} {
	const walk = ancestorWalk(doc, childType, parentType);
	return walk.kind === "one"
		? {
				identifier: walk.identifier,
				relationship: walk.relationship ?? fallback,
			}
		: { identifier: "parent", relationship: fallback };
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
export function caseListNarrowing(
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
	const formEntryList =
		module.heldKind === "advanced" ||
		module.autoSelectSingle ||
		module.caseType === "commcare-user" ||
		(doc.formOrder[moduleUuid] ?? []).some((id) => {
			const form = doc.forms[id];
			return (
				form !== undefined &&
				(form.caseSelections !== undefined || !!form.computedDatums?.length)
			);
		});
	if (moduleHasCaseListMenuItem(module) && !formEntryList) {
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
