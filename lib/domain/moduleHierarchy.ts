import type { Module } from "./modules";
import type { Uuid } from "./uuid";

/** The structural slice every menu-hierarchy projection needs. */
export interface ModuleHierarchySource {
	readonly modules: Readonly<Record<string, Module>>;
	readonly moduleOrder: readonly Uuid[];
}

export type ModuleParent = Uuid | null;

/** A case-list-only module is a direct Results destination only while it has
 * no child menus. Once it owns children, its module screen is the menu that
 * exposes those destinations and Results remains a separate entry within it. */
export function moduleIsBareCaseListDestination(
	doc: Pick<ModuleHierarchySource, "modules">,
	uuid: Uuid,
): boolean {
	const module = doc.modules[uuid];
	if (module?.caseListOnly !== true) return false;
	return !Object.values(doc.modules).some(
		(candidate) => candidate.parentModuleUuid === uuid,
	);
}

/** Nova stores roots by omission; callers use `null` as the derived root group. */
export function moduleParent(
	doc: ModuleHierarchySource,
	uuid: Uuid,
): ModuleParent | undefined {
	const module = doc.modules[uuid];
	if (module === undefined) return undefined;
	return module.parentModuleUuid ?? null;
}

/** Members of one root/child sibling group in their authored order. */
export function moduleSiblingUuids(
	doc: ModuleHierarchySource,
	parentModuleUuid: ModuleParent,
): Uuid[] {
	return doc.moduleOrder.filter((uuid) => {
		const parent = moduleParent(doc, uuid);
		return parent !== undefined && parent === parentModuleUuid;
	});
}

export function childModuleUuids(
	doc: ModuleHierarchySource,
	parentModuleUuid: Uuid,
): Uuid[] {
	return moduleSiblingUuids(doc, parentModuleUuid);
}

/** One root and its one-tier child block, in canonical preorder. */
export function moduleRootBlockUuids(
	doc: ModuleHierarchySource,
	rootModuleUuid: Uuid,
): Uuid[] {
	return [rootModuleUuid, ...childModuleUuids(doc, rootModuleUuid)];
}

/** Canonical one-tier depth-first preorder derived from parent identities. */
export function projectedModulePreorder(doc: ModuleHierarchySource): Uuid[] {
	return moduleSiblingUuids(doc, null).flatMap((rootUuid) =>
		moduleRootBlockUuids(doc, rootUuid),
	);
}
