/**
 * Named hooks — what the platform note row of one inspected owner states
 * (`lib/doc/platformNotes.ts`).
 *
 * Each subscribes with shallow equality over a small list or a boolean, so a
 * note row re-renders only when what it states changes. The use detector
 * behind them walks the whole document once per snapshot, shared by every
 * mounted row.
 */

"use client";

import type { Uuid } from "@/lib/domain";
import type { PlatformFeatureId } from "@/lib/domain/platforms";
import type { PlatformFeatureOwner } from "@/lib/domain/platformUses";
import {
	platformFeaturesOf,
	readsSearchFieldInSearchFirstForm,
} from "../platformNotes";

export { EXPRESSION_PLATFORM_FEATURES } from "../platformNotes";

import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

/** The features the owner's uses reach, kept to those the mount names (all
 *  of them when it names none), in table order. */
export function useOwnerPlatformFeatures(
	owner: PlatformFeatureOwner | undefined,
	keep?: readonly PlatformFeatureId[],
): readonly PlatformFeatureId[] {
	return useBlueprintDocShallow((doc) =>
		owner === undefined
			? []
			: platformFeaturesOf(doc, owner).filter(
					(feature) => keep === undefined || keep.includes(feature),
				),
	);
}

/** Whether the question reads a Search field in a form of a module that
 *  opens on its search. */
export function useReadsSearchFieldInSearchFirstForm(
	fieldUuid: Uuid | undefined,
): boolean {
	return useBlueprintDoc((doc) =>
		fieldUuid === undefined
			? false
			: readsSearchFieldInSearchFirstForm(doc, fieldUuid),
	);
}
