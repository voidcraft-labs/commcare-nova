/** Menu order is authored intent; array preorder is its storage projection. */
export interface DesignMenu {
	readonly id: string;
	readonly parentModuleCompositionId?: string;
}

export interface DesignMenuPlacement {
	readonly moduleId: string;
	readonly parentModuleId?: string | null;
	readonly afterModuleId?: string | null;
}

export class DesignMenuPlacementError extends Error {}

/** Partial authoring permits forward parent references. Keep those rows until
 * final reference closure, while grouping every known parent's descendants. */
export function canonicalMenuOrder<T extends DesignMenu>(
	menus: readonly T[],
): T[] {
	const result: T[] = [];
	const emitted = new Set<string>();
	const append = (menu: T) => {
		if (emitted.has(menu.id)) return;
		emitted.add(menu.id);
		result.push(menu);
		for (const child of menus) {
			if (child.parentModuleCompositionId === menu.id) append(child);
		}
	};
	for (const menu of menus) {
		if (menu.parentModuleCompositionId === undefined) append(menu);
	}
	for (const menu of menus) append(menu);
	return result;
}

/** Pure transaction: callers persist only the complete successful result. */
export function placeDesignMenus<T extends DesignMenu>(
	menus: readonly T[],
	placements: readonly DesignMenuPlacement[],
): T[] {
	let result = [...menus];
	for (const placement of placements) {
		const menu = result.find((entry) => entry.id === placement.moduleId);
		const parentId = placement.parentModuleId ?? undefined;
		const afterId = placement.afterModuleId ?? undefined;
		const parent = result.find((entry) => entry.id === parentId);
		const after = result.find((entry) => entry.id === afterId);
		const refuse = (reason: string): never => {
			throw new DesignMenuPlacementError(
				`Cannot place module ${placement.moduleId}: ${reason} Use placeModules with an existing top-level parent and a sibling in that parent.`,
			);
		};
		if (menu === undefined) refuse("the module does not exist.");
		if (parentId !== undefined && parent === undefined)
			refuse(`parent ${parentId} does not exist.`);
		if (parentId === placement.moduleId || afterId === placement.moduleId)
			refuse("a module cannot be its own parent or preceding sibling.");
		if (parent?.parentModuleCompositionId !== undefined)
			refuse("a child menu cannot be a parent.");
		if (
			parentId !== undefined &&
			result.some(
				(entry) => entry.parentModuleCompositionId === placement.moduleId,
			)
		)
			refuse("a module with children must stay top-level.");
		if (
			afterId !== undefined &&
			(after === undefined || after.parentModuleCompositionId !== parentId)
		)
			refuse(`anchor ${afterId} is not a sibling in the requested parent.`);
		const moved = { ...menu, parentModuleCompositionId: parentId } as T;
		result = result.filter((entry) => entry.id !== placement.moduleId);
		const siblings = result.filter(
			(entry) => entry.parentModuleCompositionId === parentId,
		);
		const insertion =
			afterId === undefined
				? siblings[0] === undefined
					? result.length
					: result.indexOf(siblings[0])
				: result.findIndex((entry) => entry.id === afterId) + 1;
		result.splice(insertion, 0, moved);
		result = canonicalMenuOrder(result);
	}
	return result;
}
