// components/preview/shared/PinnedCaseTile.tsx
//
// The case tile a running screen pins above itself: a menu, a case list, a
// search on Web Apps, and a form, each holding a chosen case whose list keeps
// its tile on screen, and on Android a case's details, which draw the case
// they show where the session holds none and the list chooses its own case.
// Which case, and on which screens, is one rule
// (`lib/preview/pinnedCaseTile.ts`); this reads it for a screen's held cases
// and draws the band through the one tile renderer (`PersistentCaseTile`).

"use client";
import { useMemo } from "react";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { usePreviewStandingSearchState } from "@/lib/preview/hooks/usePreviewStandingSearch";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import type { PreviewHeldCaseSelection } from "@/lib/preview/menuProjection";
import {
	type PinnedTileSurface,
	type PreviewPinnedCaseTile,
	type PreviewViewedCase,
	pinnedTileSearchReading,
	previewPinnedCaseTile,
} from "@/lib/preview/pinnedCaseTile";
import {
	useAppId,
	usePreviewPersonaUuid,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";
import { PersistentCaseTile } from "./PersistentCaseTile";

/** The tile a screen holding these cases pins on the platform Preview plays,
 *  or none. `held` is in the order the session chose them; `viewing` is the
 *  case a case's details show. */
export function usePinnedCaseTile(
	held: readonly PreviewHeldCaseSelection[],
	surface: PinnedTileSurface,
	viewing?: PreviewViewedCase,
): PreviewPinnedCaseTile | undefined {
	const { modules } = usePreviewMenuSource();
	const rules = usePreviewPlatformRules();
	const pinned = previewPinnedCaseTile(modules, held, surface, rules, viewing);
	const moduleUuid = pinned?.moduleUuid;
	const caseId = pinned?.caseId;
	return useMemo(
		() =>
			moduleUuid === undefined || caseId === undefined
				? undefined
				: { moduleUuid, caseId },
		[moduleUuid, caseId],
	);
}

/** The pinned band: the case's tile, drawn by the list that chose it, read
 *  where that list reads the case (`pinnedTileSearchReading`). */
export function PinnedCaseTile({
	pinned,
}: {
	readonly pinned: PreviewPinnedCaseTile;
}) {
	const menuSource = usePreviewMenuSource();
	const appId = useAppId();
	const caseTypes = useMaterializableCaseTypes();
	const restoreScopeKey = useRestoreScopeKey(usePreviewPersonaUuid());
	const mod = menuSource.doc.modules[pinned.moduleUuid];
	const searchReading = pinnedTileSearchReading(
		mod,
		usePreviewStandingSearchState(pinned.moduleUuid),
	);
	if (mod?.caseListConfig === undefined) return null;
	return (
		<PersistentCaseTile
			blueprint={menuSource.doc}
			moduleUuid={pinned.moduleUuid}
			appId={appId}
			caseType={mod.caseType}
			caseId={pinned.caseId}
			config={mod.caseListConfig}
			caseTypes={caseTypes}
			fallbackProperties={
				caseTypes.find((candidate) => candidate.name === mod.caseType)
					?.properties ?? []
			}
			restoreScopeKey={restoreScopeKey}
			searchReading={searchReading}
		/>
	);
}
