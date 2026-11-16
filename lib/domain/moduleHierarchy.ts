import type { BlueprintDoc } from "./blueprint";
import { moduleIsBareCaseList } from "./menuForms";
import type { Module } from "./modules";
import { isSettled } from "./settled";
import type { Uuid } from "./uuid";

/** The structural slice every menu-hierarchy projection needs. */
export interface ModuleHierarchySource {
	readonly modules: Readonly<Record<string, Module>>;
	readonly moduleOrder: readonly Uuid[];
}

export type ModuleParent = Uuid | null;

/** A bare case list (`menuForms.ts::moduleIsBareCaseList`) is a direct
 * Results destination only while it has no child menus. Once it owns
 * children, its module screen is the menu that exposes those destinations and
 * Results remains a separate entry within it. */
export function moduleIsBareCaseListDestination(
	doc: Pick<BlueprintDoc, "modules" | "forms" | "formOrder">,
	uuid: Uuid,
): boolean {
	if (!moduleIsBareCaseList(doc, uuid)) return false;
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

/**
 * `moduleSiblingUuids` for every sibling group at once, from one walk of
 * `moduleOrder`: a caller that asks of every group asks in time linear in
 * the menus rather than once per group.
 */
export function moduleSiblingGroups(
	doc: ModuleHierarchySource,
): (parentModuleUuid: ModuleParent) => readonly Uuid[] {
	const groups = new Map<ModuleParent, Uuid[]>();
	for (const uuid of doc.moduleOrder) {
		const parent = moduleParent(doc, uuid);
		if (parent === undefined) continue;
		const group = groups.get(parent);
		if (group === undefined) groups.set(parent, [uuid]);
		else group.push(uuid);
	}
	return (parentModuleUuid) => groups.get(parentModuleUuid) ?? [];
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

/** Canonical one-tier depth-first preorder derived from parent identities.
 *
 * One pass groups each parent's children in `moduleOrder`'s order, so the
 * preorder costs time linear in the menus: the validator asks for it once
 * per screen, and a quadratic preorder made that cubic in the menus. */
export function projectedModulePreorder(doc: ModuleHierarchySource): Uuid[] {
	const roots: Uuid[] = [];
	const children = new Map<Uuid, Uuid[]>();
	for (const uuid of doc.moduleOrder) {
		const parent = moduleParent(doc, uuid);
		if (parent === undefined) continue;
		if (parent === null) {
			roots.push(uuid);
			continue;
		}
		const block = children.get(parent);
		if (block === undefined) children.set(parent, [uuid]);
		else block.push(uuid);
	}
	const preorder: Uuid[] = [];
	for (const rootUuid of roots) {
		preorder.push(rootUuid);
		const block = children.get(rootUuid);
		if (block !== undefined) preorder.push(...block);
	}
	return preorder;
}

/** The modules of `projectedModulePreorder`, by a settled `moduleOrder` and
 *  `modules`. */
const projectedByOrder = new WeakMap<
	object,
	WeakMap<object, ReadonlySet<Uuid>>
>();

/**
 * The modules `projectedModulePreorder` lists, as a set. The preorder reads
 * `moduleOrder` and each module's parent, so the set is remembered by those
 * two records' identity only where both, and every module, are frozen and no
 * Immer draft: a check asked once per menu then derives it once per document,
 * not once per menu. Anything else is derived again.
 */
export function projectedModuleSet(
	doc: ModuleHierarchySource,
): ReadonlySet<Uuid> {
	const byModules = projectedByOrder.get(doc.moduleOrder);
	const known = byModules?.get(doc.modules);
	if (known !== undefined) return known;
	const set: ReadonlySet<Uuid> = new Set(projectedModulePreorder(doc));
	if (
		isSettled(doc.moduleOrder) &&
		isSettled(doc.modules) &&
		Object.values(doc.modules).every(
			(mod) => typeof mod === "object" && mod !== null && isSettled(mod),
		)
	) {
		let held = byModules;
		if (held === undefined) {
			held = new WeakMap();
			projectedByOrder.set(doc.moduleOrder, held);
		}
		held.set(doc.modules, set);
	}
	return set;
}
