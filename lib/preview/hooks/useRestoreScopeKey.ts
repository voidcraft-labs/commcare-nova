// lib/preview/hooks/useRestoreScopeKey.ts
//
// One dependency value for everything a worker's restore is derived from.
//
// `resolveRestoreScope` answers from three inputs, and the running preview
// caches its rows under a key that names none of them:
//
//   1. which places the persona is assigned to (blueprint: `persona.locations`)
//   2. which levels own cases, and how far down each one reaches
//      (blueprint: `organizationLevels`)
//   3. the place tree itself (Postgres: `app_locations`)
//
// Change any one and the same persona holds a different set of cases. Without
// this key the preview keeps serving the previous worker's rows with nothing
// on screen to say so — which is the exact failure the reveal note exists to
// prevent, arriving through the back door.

"use client";

import { useEffect, useState } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { assignedLocationUuids } from "@/lib/domain";

/**
 * A monotonic clock for this app's place tree.
 *
 * Places live in Postgres, not in the document, so no doc subscription can see
 * them move. The builder stream's payload-free organization poke is the only
 * client-side signal that they did — the same one `useOrganization` reloads
 * on. Null outside a live builder session (replay, tests): there is no stream
 * to subscribe to, and the mount read is still fresh.
 */
function useOrganizationClock(): number {
	const collab = useReconcilerContext();
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (collab === null) return;
		return collab.subscribeAppOrganization(() => {
			setTick((previous) => previous + 1);
		});
	}, [collab]);
	return tick;
}

/**
 * The cache-key contribution that makes a case read follow its worker.
 *
 * Fold this into `requestScopeKey` on every preview surface that reads cases
 * through a restore. It is a signature, not a description: its only contract
 * is that it differs whenever the resolved owner set could differ, so it is
 * deliberately coarse — the whole level catalog rather than the fields today's
 * derivation happens to consult. A narrower signature would have to be revised
 * every time `personaOwnerIds` grew an input, and forgetting is silent.
 *
 * Previewing as the signed-in member is a worker assigned nowhere, so its
 * owner set is their own id and depends on none of this.
 */
export function useRestoreScopeKey(personaUuid: string | undefined): string {
	const clock = useOrganizationClock();
	const assignment = useBlueprintDoc((state) => {
		if (personaUuid === undefined) return "me";
		const persona = state.personas?.[personaUuid];
		if (persona === undefined) return "absent";
		return assignedLocationUuids(persona.locations).join(",");
	});
	const levels = useBlueprintDoc((state) => {
		if (personaUuid === undefined) return "";
		return Object.entries(state.organizationLevels ?? {})
			.map(([uuid, level]) => `${uuid}=${JSON.stringify(level)}`)
			.sort()
			.join("|");
	});
	return `${clock} ${assignment} ${levels}`;
}
