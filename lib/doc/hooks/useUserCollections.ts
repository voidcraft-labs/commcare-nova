/**
 * Reads over the three user collections — the worker-information
 * catalog, the roles built on it, and the personas that act as those
 * roles.
 *
 * Each collection is a UUID-keyed record paired with a membership array that IS
 * the sequence. The hooks resolve the array against the record because every
 * surface wants the entities in order; nothing reads the raw record.
 *
 * The array is walked, never sorted. An entity the array does not name is not
 * displayed — the two disagreeing is a state `assembleBlueprint` refuses to
 * persist, so tolerating it here would only hide it.
 */
"use client";

import { useMemo } from "react";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Persona, UserProperty, UserType, Uuid } from "@/lib/domain";

function inOrder<T>(
	record: Record<string, T> | undefined,
	order: readonly Uuid[] | undefined,
): T[] {
	if (record === undefined) return [];
	const out: T[] = [];
	for (const uuid of order ?? []) {
		const entity = record[uuid];
		if (entity !== undefined) out.push(entity);
	}
	return out;
}

/** The app's worker-information catalog, in display order. */
export function useUserProperties(): UserProperty[] {
	const record = useBlueprintDoc((s) => s.userProperties);
	const order = useBlueprintDoc((s) => s.userPropertyOrder);
	return useMemo(() => inOrder(record, order), [record, order]);
}

/** The app's roles, in display order. */
export function useUserTypes(): UserType[] {
	const record = useBlueprintDoc((s) => s.userTypes);
	const order = useBlueprintDoc((s) => s.userTypeOrder);
	return useMemo(() => inOrder(record, order), [record, order]);
}

/** The app's personas, in display order. */
export function usePersonas(): Persona[] {
	const record = useBlueprintDoc((s) => s.personas);
	const order = useBlueprintDoc((s) => s.personaOrder);
	return useMemo(() => inOrder(record, order), [record, order]);
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
