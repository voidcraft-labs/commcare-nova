// lib/preview/hooks/useClaimSearchedCases.ts
//
// The running app's claim of searched cases: the claim CommCare posts where
// a worker chooses a case its device does not hold
// (`lib/preview/searchClaims.ts` says where and which ids). The claim is a
// case row the worker owns (`claimSearchedCasesAction`), so after it the
// worker's restore holds the case, and every surface that reads the device
// reads again: when the claim created a row, every case type of the app is
// invalidated, which is the device snapshot's revision
// (`caseDataInvalidation.ts::useCaseDatabaseRevision`), as a device restores
// after a new claim. Android follows every claim with a sync
// (`rules.claimThenSync`, manifest
// `case-search/the-generated-search-round-trip-remote-request-query-results`),
// so there the read happens after every claim and the phone's last sync
// advances as Sync with server advances it.
//
// `inFlightCaseIds` are the ids of the claims the device snapshot may not
// show yet: a claim still posting, and a claim that changed the device whose
// read has not landed. The screen hands them to
// `searchClaims.ts::deviceCasesHoldingClaims`, so a menu condition that
// reads the device's cases waits rather than reading a claimed case as
// missing.

"use client";

import {
	useCallback,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { effectiveCaseTypes } from "@/lib/domain";
import { claimSearchedCasesAction } from "@/lib/preview/engine/caseDataBinding";
import type { ClaimSearchedCasesResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { withNavigationWidth } from "@/lib/preview/engine/previewDevice";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { previewPlatformRules } from "@/lib/preview/platform";
import {
	useMarkPreviewDeviceSynced,
	usePreviewDevice,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { invalidateCaseData } from "./caseDataInvalidation";

/** What a claim answered. `superseded`: the app, its Project scope or the
 *  running worker changed while the claim posted, so its answer belongs to a
 *  screen no longer showing; the claim row, if written, stays the earlier
 *  worker's. */
export type ClaimOutcome =
	| ClaimSearchedCasesResult
	| { readonly kind: "superseded" };

const CLAIM_TRANSPORT_MESSAGE =
	"Couldn't open this case. Try again in a moment.";

const NO_CASE_IDS: readonly string[] = [];

interface ClaimInFlight {
	readonly token: number;
	readonly caseIds: readonly string[];
	/** Undefined while the claim posts; once it settled, the device snapshot
	 *  that was showing then. The claim stops waiting when a newer snapshot
	 *  lands. */
	readonly settledOver?: CaseDatabaseSnapshot | null;
}

const serverSnapshot = () => null;

export function useClaimSearchedCases(): {
	claim(caseIds: readonly string[]): Promise<ClaimOutcome>;
	inFlightCaseIds: readonly string[];
} {
	const session = useBuilderSessionApi();
	const doc = useBlueprintDocApi();
	const device = usePreviewDevice();
	const markSynced = useMarkPreviewDeviceSynced();
	const controller = useBuilderFormEngine();
	const snapshot = useSyncExternalStore(
		controller.subscribeDeviceCaseDatabase,
		() => controller.deviceCaseDatabase,
		serverSnapshot,
	);
	const [claims, setClaims] = useState<readonly ClaimInFlight[]>([]);
	const nextToken = useRef(0);

	const claim = useCallback(
		async (caseIds: readonly string[]): Promise<ClaimOutcome> => {
			if (caseIds.length === 0)
				return { kind: "claimed", created: [], alreadyClaimed: [] };
			const before = session.getState();
			const appId = before.appId;
			if (appId === undefined)
				return { kind: "refused", message: CLAIM_TRANSPORT_MESSAGE };
			nextToken.current += 1;
			const token = nextToken.current;
			const ids = [...new Set(caseIds)];
			/* A claim that settled over the snapshot now showing is done waiting
			 * once a newer one landed: drop it with the new claim's start. */
			const showing = controller.deviceCaseDatabase;
			setClaims((current) => [
				...current.filter(
					(entry) =>
						entry.settledOver === undefined || entry.settledOver === showing,
				),
				{ token, caseIds: ids },
			]);
			let result: ClaimOutcome;
			try {
				result = await claimSearchedCasesAction({
					appId,
					caseIds: ids,
					...(before.previewPersonaUuid === undefined
						? {}
						: { personaUuid: before.previewPersonaUuid }),
					device: withNavigationWidth(device),
				});
			} catch {
				result = { kind: "refused", message: CLAIM_TRANSPORT_MESSAGE };
			}
			const rules = previewPlatformRules(device.platform);
			const rereads =
				result.kind === "claimed" &&
				(result.created.length > 0 || rules.claimThenSync);
			if (rereads) {
				for (const caseType of effectiveCaseTypes(doc.getState()))
					invalidateCaseData(appId, caseType.name);
				if (rules.claimThenSync) markSynced(Date.now());
			}
			/* A claim that changed nothing on the device, or did not land,
			 * waits for nothing; one the device reads again waits for the read.
			 * With no snapshot showing there is nothing a newer read replaces:
			 * every condition that reads the device's cases waits on its load. */
			const settledOver = controller.deviceCaseDatabase;
			setClaims((current) =>
				rereads && settledOver !== null
					? current.map((entry) =>
							entry.token === token ? { ...entry, settledOver } : entry,
						)
					: current.filter((entry) => entry.token !== token),
			);
			const after = session.getState();
			if (
				after.appId !== appId ||
				after.scopeEpoch !== before.scopeEpoch ||
				after.previewPersonaUuid !== before.previewPersonaUuid
			)
				return { kind: "superseded" };
			return result;
		},
		[controller, device, doc, markSynced, session],
	);

	const inFlightCaseIds = useMemo(() => {
		const waiting = claims.filter(
			(entry) =>
				entry.settledOver === undefined || entry.settledOver === snapshot,
		);
		return waiting.length === 0
			? NO_CASE_IDS
			: [...new Set(waiting.flatMap((entry) => entry.caseIds))];
	}, [claims, snapshot]);

	return { claim, inFlightCaseIds };
}
