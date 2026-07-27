/**
 * Reads over the three user collections — the worker-information
 * catalog, the roles built on it, and the personas that act as those
 * roles.
 *
 * Each collection is a flat UUID-keyed record with no membership array,
 * so display sequence comes from each entity's fractional `order` key
 * (`byFlatEntitySortKey`). The hooks return sorted arrays because every surface
 * wants them in order; nothing reads the raw record.
 */
"use client";

import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { byFlatEntitySortKey } from "@/lib/doc/order/compare";
import type { Persona, UserProperty, UserType } from "@/lib/domain";

function sorted<T extends { order?: string; uuid: string }>(
	record: Record<string, T> | undefined,
): T[] {
	return Object.values(record ?? {}).sort(byFlatEntitySortKey);
}

/** The app's worker-information catalog, in display order. */
export function useUserProperties(): UserProperty[] {
	const record = useBlueprintDoc((s) => s.userProperties);
	return useMemo(() => sorted(record), [record]);
}

/** The app's roles, in display order. */
export function useUserTypes(): UserType[] {
	const record = useBlueprintDoc((s) => s.userTypes);
	return useMemo(() => sorted(record), [record]);
}

/** The app's personas, in display order. */
export function usePersonas(): Persona[] {
	const record = useBlueprintDoc((s) => s.personas);
	return useMemo(() => sorted(record), [record]);
}

/**
 * The three collections together, for surfaces that need to resolve a
 * persona's effective data (which reads roles and properties too).
 * Shallow-stable per doc reference.
 */
export function useUserCollections(): {
	userProperties: Record<string, UserProperty>;
	userTypes: Record<string, UserType>;
	personas: Record<string, Persona>;
} {
	const userProperties = useBlueprintDoc((s) => s.userProperties);
	const userTypes = useBlueprintDoc((s) => s.userTypes);
	const personas = useBlueprintDoc((s) => s.personas);
	return useMemo(
		() => ({
			userProperties: userProperties ?? {},
			userTypes: userTypes ?? {},
			personas: personas ?? {},
		}),
		[userProperties, userTypes, personas],
	);
}
