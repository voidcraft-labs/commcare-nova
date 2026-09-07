/**
 * Reads over the organization's SHAPE — the rungs, and the catalog of
 * information the places at those rungs carry.
 *
 * The places themselves are not here and never will be: they are
 * app-scoped Postgres rows, read through `lib/organization`'s own hook.
 * A surface that needs both holds two subscriptions, which is honest —
 * they change for different reasons and at different rates.
 *
 * Both collections are flat UUID-keyed records paired with membership arrays.
 * The array is the sequence, exactly like the worker-information collections.
 */
"use client";

import { useMemo } from "react";
import {
	useBlueprintDoc,
	useBlueprintDocShallow,
} from "@/lib/doc/hooks/useBlueprintDoc";
import { removeOrganizationLevelPlan } from "@/lib/doc/organizationMutations";
import type { LocationProperty, OrganizationLevel, Uuid } from "@/lib/domain";
import type { OrganizationRuleInputs } from "@/lib/organization/ownerTargetVerdicts";

function inSequence<T>(
	record: Record<string, T> | undefined,
	order: readonly string[] | undefined,
): T[] {
	const out: T[] = [];
	for (const uuid of order ?? []) {
		const entity = record?.[uuid];
		if (entity !== undefined) out.push(entity);
	}
	return out;
}

/** The app's organization levels, in canonical membership-array order. */
export function useOrganizationLevels(): OrganizationLevel[] {
	const record = useBlueprintDoc((s) => s.organizationLevels);
	const order = useBlueprintDoc((s) => s.organizationLevelOrder);
	return useMemo(() => inSequence(record, order), [order, record]);
}

/** The app's place-information catalog, in display order. */
export function useLocationProperties(): LocationProperty[] {
	const record = useBlueprintDoc((s) => s.locationProperties);
	const order = useBlueprintDoc((s) => s.locationPropertyOrder);
	return useMemo(() => inSequence(record, order), [order, record]);
}

/** The levels as a record, for surfaces resolving a reference by uuid. */
export function useOrganizationLevelRecord(): Record<
	string,
	OrganizationLevel
> {
	const record = useBlueprintDoc((s) => s.organizationLevels);
	return useMemo(() => record ?? Object.create(null), [record]);
}

/** Owner and assignment preflights also read case operations in every form.
 * Field edits, translation overlays, and session bookkeeping are not inputs. */
export function useOrganizationRuleInputs(): OrganizationRuleInputs {
	return useBlueprintDocShallow((state) => ({
		forms: state.forms,
		personas: state.personas,
		organizationLevels: state.organizationLevels,
		organizationLevelOrder: state.organizationLevelOrder,
	}));
}

/** Removal also checks the app-wide reference index, beyond owner-rule inputs. */
export function useOrganizationLevelRemovalPlan(uuid: Uuid, occupied: boolean) {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() =>
			removeOrganizationLevelPlan(
				doc,
				uuid,
				occupied ? new Set([uuid]) : undefined,
			),
		[doc, uuid, occupied],
	);
}
