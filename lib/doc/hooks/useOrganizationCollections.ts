/**
 * Reads over the organization's SHAPE — the rungs, and the catalog of
 * information the places at those rungs carry.
 *
 * The places themselves are not here and never will be: they are
 * app-scoped Postgres rows, read through `lib/organization`'s own hook.
 * A surface that needs both holds two subscriptions, which is honest —
 * they change for different reasons and at different rates.
 *
 * Both collections are flat UUID-keyed records with no membership array,
 * so display sequence comes from each entity's fractional `order` key.
 */
"use client";

import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { bySortKey } from "@/lib/doc/order/compare";
import type { LocationProperty, OrganizationLevel } from "@/lib/domain";

function sorted<T extends { order?: string; uuid: string }>(
	record: Record<string, T> | undefined,
): T[] {
	return Object.values(record ?? {}).sort(bySortKey);
}

/**
 * The app's organization levels, top rung first.
 *
 * Sorted by depth rather than by the fractional key, because a level's
 * place in the hierarchy IS its order and showing them any other way
 * would invite an author to read the list as the structure. Siblings
 * within a depth keep their authored order.
 */
export function useOrganizationLevels(): OrganizationLevel[] {
	const record = useBlueprintDoc((s) => s.organizationLevels);
	return useMemo(() => {
		const levels = sorted(record);
		const byUuid = new Map(levels.map((level) => [level.uuid, level]));
		const depthOf = (level: OrganizationLevel): number => {
			let depth = 0;
			const seen = new Set<string>([level.uuid]);
			let current = level;
			while (current.parentLevelUuid !== undefined) {
				if (seen.has(current.parentLevelUuid)) break;
				const parent = byUuid.get(current.parentLevelUuid);
				if (parent === undefined) break;
				seen.add(parent.uuid);
				depth += 1;
				current = parent;
			}
			return depth;
		};
		const depths = new Map(levels.map((level) => [level.uuid, depthOf(level)]));
		return levels
			.slice()
			.sort((a, b) => (depths.get(a.uuid) ?? 0) - (depths.get(b.uuid) ?? 0));
	}, [record]);
}

/** The app's place-information catalog, in display order. */
export function useLocationProperties(): LocationProperty[] {
	const record = useBlueprintDoc((s) => s.locationProperties);
	return useMemo(() => sorted(record), [record]);
}

/** The levels as a record, for surfaces resolving a reference by uuid. */
export function useOrganizationLevelRecord(): Record<
	string,
	OrganizationLevel
> {
	const record = useBlueprintDoc((s) => s.organizationLevels);
	return useMemo(() => record ?? {}, [record]);
}
