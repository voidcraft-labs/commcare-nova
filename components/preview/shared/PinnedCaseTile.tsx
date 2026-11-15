// components/preview/shared/PinnedCaseTile.tsx
//
// The case tile a running screen pins above itself: a menu, a case list, a
// search on Web Apps, and a form, each holding a chosen case whose list keeps
// its tile on screen. Which case, and on which screens, is one rule
// (`lib/preview/pinnedCaseTile.ts`); this reads it for a screen's held cases
// and draws the band through the one tile renderer (`PersistentCaseTile`).

"use client";
import { useMemo } from "react";
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import type { PreviewHeldCaseSelection } from "@/lib/preview/menuProjection";
import {
	type PinnedTileSurface,
	type PreviewPinnedCaseTile,
	previewPinnedCaseTile,
} from "@/lib/preview/pinnedCaseTile";
import {
	useAppId,
	usePreviewPersonaUuid,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";
import { PersistentCaseTile } from "./PersistentCaseTile";

/** The tile a screen holding these cases pins on the platform Preview plays,
 *  or none. `held` is in the order the session chose them. */
export function usePinnedCaseTile(
	held: readonly PreviewHeldCaseSelection[],
	surface: PinnedTileSurface,
): PreviewPinnedCaseTile | undefined {
	const { modules } = usePreviewMenuSource();
	const rules = usePreviewPlatformRules();
	const pinned = previewPinnedCaseTile(modules, held, surface, rules);
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

/** The pinned band: the case's tile, drawn by the list that chose it. */
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
		/>
	);
}
