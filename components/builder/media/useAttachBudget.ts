// components/builder/media/useAttachBudget.ts
//
// The browser slots' pre-dispatch export-ceiling check — the client
// twin of the SA/MCP attach verdict's budget arm. Both run the SAME
// arithmetic and speak the SAME rejection prose
// (`lib/media/exportBudget.ts`), so an honest user hears "this would
// put the app over its media export limit" at the click, never at the
// export door.
//
// Trust model (documented in full where the math lives): this check is
// the honest-user UX guarantee, not the enforcement — the export
// boundary re-loads fresh rows server-side and refuses an over-budget
// app regardless of anything a client did. That's why the check FAILS
// OPEN when it can't resolve a referenced asset's metadata (a transient
// fetch failure must not block a legitimate attach), and why the
// session-store registry it reads can tolerate staleness.
//
// Inputs: the doc's referenced asset ids (an imperative read of the doc
// store), the session's asset-metadata registry (fed by every library
// page the pickers load, every upload confirm, and this hook's own
// fetches), and the candidate asset the slot is about to attach. Ids
// the registry doesn't know are loaded through the library route's
// resolve mode before judging — so the check is complete even for refs
// attached in earlier sessions or by the SA.

"use client";

import { useCallback } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	type ExportBudgetRowView,
	postAttachBudgetError,
} from "@/lib/media/exportBudget";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { fetchAssetsByIds, type MediaAssetView } from "./mediaClient";

/** Outcome of the budget check — mirrors the server verdict's shape so
 *  call sites read the same way on both surfaces. */
export type AttachBudgetVerdict = { ok: true } | { ok: false; error: string };

/**
 * Returns `checkAttachBudget(candidate)`: would attaching this asset
 * push the app's referenced-ready-media aggregate past the export
 * ceiling? Resolves the doc's referenced ids against the session's
 * registry, fetches only the gaps, and judges via the shared math.
 *
 * Async because of the gap fetch; both attach entry points (library
 * pick, staged-upload confirm) already dispatch from async handlers.
 */
export function useAttachBudgetGuard(): (
	candidate: MediaAssetView,
) => Promise<AttachBudgetVerdict> {
	const docApi = useBlueprintDocApi();
	const session = useBuilderSessionApi();

	return useCallback(
		async (candidate: MediaAssetView) => {
			// Built-in icons (`nova-icon:<slug>`) are shared, tiny, and have no
			// Firestore row — they can't meaningfully move the export budget and a
			// gap-fetch for one would 404. Picking one always passes.
			if (isBuiltinIconRef(candidate.id)) return { ok: true };

			// The candidate's own row is known-good metadata — record it so
			// a later check (or a re-attach) needs no fetch for it.
			session.getState().recordAssetMeta([candidate]);

			// Drop built-in refs already in the doc: they're not Firestore assets,
			// so the gap-fetch below would 404 on them, and they don't count toward
			// this courtesy check (the export boundary still tallies them).
			const referencedIds = [...collectAssetRefs(docApi.getState())].filter(
				(id) => !isBuiltinIconRef(id),
			);
			const known = session.getState().assetMeta;
			const missing = referencedIds.filter(
				(id) => known[id] === undefined && id !== candidate.id,
			);
			if (missing.length > 0) {
				try {
					// Resolve the gaps against the current app's Project (the server
					// reads `appId`), the same tenant the refs were attached under.
					session
						.getState()
						.recordAssetMeta(
							await fetchAssetsByIds(missing, session.getState().appId),
						);
				} catch {
					// Fail OPEN: an unresolvable ref can only make this courtesy
					// check miss, and the export boundary is the authority —
					// refusing a legitimate attach over a transient fetch would
					// be the worse failure.
				}
			}

			const rowsById = new Map<string, ExportBudgetRowView>(
				Object.entries(session.getState().assetMeta),
			);
			const error = postAttachBudgetError({
				referencedIds,
				rowsById,
				candidate: {
					id: candidate.id,
					status: candidate.status,
					kind: candidate.kind,
					sizeBytes: candidate.sizeBytes,
				},
			});
			return error === null ? { ok: true } : { ok: false, error };
		},
		[docApi, session],
	);
}
