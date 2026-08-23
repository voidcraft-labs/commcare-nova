import {
	CASE_FORM_TYPES,
	type CaseType,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	type ModuleHierarchySource,
	moduleParent,
	moduleSiblingUuids,
} from "@/lib/domain/moduleHierarchy";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import {
	moduleDisplayVisibility,
	type NavigationItemVisibility,
} from "./engine/displayConditionEvaluation";
import type { PreviewSearchSessionValues } from "./engine/identity";
import type { PreviewLookupStatus } from "./engine/useLookupPreviewData";

export interface PreviewMenuSource extends ModuleHierarchySource {
	readonly caseTypes: readonly CaseType[];
	readonly forms: Readonly<Record<string, Form>>;
	readonly formOrder: Readonly<Record<string, readonly Uuid[]>>;
}

/** The module tiles shown on one menu screen. `null` names Home. */
export function previewMenuModuleUuids(
	doc: ModuleHierarchySource,
	parentModuleUuid: Uuid | null,
): Uuid[] {
	return moduleSiblingUuids(doc, parentModuleUuid);
}

/** Boolean conjunction in Preview's three-valued navigation domain.
 * A known false result wins over loading; otherwise loading propagates. */
export function combineNavigationVisibility(
	ancestor: NavigationItemVisibility,
	own: NavigationItemVisibility,
): NavigationItemVisibility {
	if (ancestor === "hidden" || own === "hidden") return "hidden";
	if (ancestor === "pending" || own === "pending") return "pending";
	return "shown";
}

/** Project each module's own condition through its menu ancestry. */
export function inheritedModuleVisibility(
	doc: ModuleHierarchySource,
	own: ReadonlyMap<Uuid, NavigationItemVisibility>,
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	const result = new Map<Uuid, NavigationItemVisibility>();
	for (const uuid of doc.moduleOrder) {
		const ownVisibility = own.get(uuid) ?? "shown";
		const parentUuid = moduleParent(doc, uuid);
		if (parentUuid === undefined || parentUuid === null) {
			result.set(uuid, ownVisibility);
			continue;
		}
		result.set(
			uuid,
			combineNavigationVisibility(
				result.get(parentUuid) ?? own.get(parentUuid) ?? "shown",
				ownVisibility,
			),
		);
	}
	return result;
}

/** The one running-menu visibility projection used by tiles and direct-route
 * admission. Edit mode keeps authoring surfaces reachable; Preview evaluates
 * each module once and then applies structural ancestry. */
export function previewModuleVisibility(
	doc: PreviewMenuSource,
	args: {
		readonly authoring: boolean;
		readonly session: PreviewSearchSessionValues;
		readonly lookup: PreviewLookupStatus;
	},
): ReadonlyMap<Uuid, NavigationItemVisibility> {
	const own = new Map(
		doc.moduleOrder.map((uuid) => {
			const mod = doc.modules[uuid];
			return [
				uuid,
				args.authoring || mod === undefined
					? ("shown" as const)
					: moduleDisplayVisibility({
							condition: mod.displayCondition,
							session: args.session,
							...(mod.caseType !== undefined && {
								currentCaseType: mod.caseType,
							}),
							lookup: args.lookup,
						}),
			] as const;
		}),
	);
	return inheritedModuleVisibility(doc, own);
}

export interface PreviewMenuCaseContext {
	/** Case bound to this module menu. May be inherited from its structural
	 * parent when both menus use the same case type. */
	readonly selectedCase: PreviewMenuCaseSelection | undefined;
	readonly selectedByModuleUuid: Uuid | undefined;
	/** A different-type case parent's selection. This constrains which cases
	 * the child may select; it is independent of the structural menu parent. */
	readonly parentCase: PreviewMenuCaseSelection | undefined;
	readonly parentModuleUuid: Uuid | undefined;
	/** The case-type selector still required before this module can run. */
	readonly requiredParentCase:
		| { readonly caseType: string; readonly moduleUuid: Uuid }
		| undefined;
}

/**
 * Resolve the running menu's case context without confusing the menu tree
 * with the case-type tree. Structural ancestry permits only the deliberate
 * same-type reuse. Case-type ancestry independently finds the module HQ's
 * `parent_select` would use and either carries its selection or requests it.
 */
export function previewMenuCaseContext(
	doc: PreviewMenuSource,
	moduleUuid: Uuid,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
): PreviewMenuCaseContext {
	const mod = doc.modules[moduleUuid];
	if (!mod) return emptyCaseContext();

	const direct = matchingSelection(selections[moduleUuid], mod.caseType);
	const structuralParentUuid = moduleParent(doc, moduleUuid);
	const structuralParentSelection =
		structuralParentUuid === undefined || structuralParentUuid === null
			? undefined
			: matchingSelection(
					selections[structuralParentUuid],
					doc.modules[structuralParentUuid]?.caseType,
				);
	const inherited =
		structuralParentSelection?.caseType === mod.caseType
			? structuralParentSelection
			: undefined;
	const selectedCase = direct ?? inherited;
	const selectedByModuleUuid = direct
		? moduleUuid
		: inherited
			? (structuralParentUuid ?? undefined)
			: undefined;

	if (!mod.caseType) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	const childCaseType = doc.caseTypes.find(
		(type) => type.name === mod.caseType,
	);
	const parentCaseType = childCaseType?.parent_type;
	if (!parentCaseType) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	const caseParentModuleUuid = doc.moduleOrder.find((candidateUuid) => {
		if (candidateUuid === moduleUuid) return false;
		const candidate = doc.modules[candidateUuid];
		if (candidate?.caseType !== parentCaseType) return false;
		/* Match the case-activity gate used by the emitted parent-select
		 * projection. A survey-only module may retain a case type for authoring,
		 * but it has no case session and cannot act as a parent selector. */
		return (
			candidate.caseListOnly === true ||
			(doc.formOrder[candidateUuid] ?? []).some((formUuid) => {
				const form = doc.forms[formUuid];
				return form !== undefined && CASE_FORM_TYPES.has(form.type);
			})
		);
	});
	if (!caseParentModuleUuid) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
		};
	}
	const caseParentSelection = matchingSelection(
		selections[caseParentModuleUuid],
		parentCaseType,
	);
	if (!caseParentSelection) {
		return {
			...emptyCaseContext(),
			selectedCase,
			selectedByModuleUuid,
			requiredParentCase: {
				caseType: parentCaseType,
				moduleUuid: caseParentModuleUuid,
			},
		};
	}
	return {
		selectedCase,
		selectedByModuleUuid,
		parentCase: caseParentSelection,
		parentModuleUuid: caseParentModuleUuid,
		requiredParentCase: undefined,
	};
}

export function moduleHasChildren(
	doc: ModuleHierarchySource,
	moduleUuid: Uuid,
): boolean {
	return moduleSiblingUuids(doc, moduleUuid).length > 0;
}

/** Module selections made stale by choosing a new case of `ancestorCaseType`.
 * Case ancestry is deliberately independent of menu ancestry, so this walks
 * the case-type graph and then projects matching modules wherever they live in
 * the menu tree. The fixed-point walk is cycle-safe for a malformed snapshot. */
export function previewCaseDescendantModuleUuids(
	doc: PreviewMenuSource,
	ancestorCaseType: string,
): Uuid[] {
	const descendants = new Set<string>();
	for (let pass = 0; pass < doc.caseTypes.length; pass++) {
		let changed = false;
		for (const candidate of doc.caseTypes) {
			if (
				candidate.parent_type !== undefined &&
				(candidate.parent_type === ancestorCaseType ||
					descendants.has(candidate.parent_type)) &&
				!descendants.has(candidate.name)
			) {
				descendants.add(candidate.name);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return doc.moduleOrder.filter((uuid) => {
		const caseType = doc.modules[uuid]?.caseType;
		return caseType !== undefined && descendants.has(caseType);
	});
}

function matchingSelection(
	selection: PreviewMenuCaseSelection | undefined,
	caseType: Module["caseType"],
): PreviewMenuCaseSelection | undefined {
	return selection?.caseType === caseType ? selection : undefined;
}

function emptyCaseContext(): PreviewMenuCaseContext {
	return {
		selectedCase: undefined,
		selectedByModuleUuid: undefined,
		parentCase: undefined,
		parentModuleUuid: undefined,
		requiredParentCase: undefined,
	};
}
