// components/builder/media/useAttachGuard.ts
//
// The browser slots' pre-dispatch attach check: the client twin of the
// SA/MCP attach verdict's platform arm. A file the app's platforms can't
// play is refused at the click (`platformPlayback.ts`), in the same prose
// the commit kernel would refuse it in, so a refused builder batch never
// reloads the builder. No total of the app's media bounds an attach: every
// export streams the files one at a time.
//
// Trust model: this check is the honest-user UX guarantee, not the
// enforcement. The commit kernel and the export boundary re-load fresh
// rows server-side regardless of anything a client did.

"use client";

import { useCallback } from "react";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { declaredPlatforms } from "@/lib/domain/platforms";
import { attachPlatformSentence } from "@/lib/media/platformPlayback";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { MediaAssetView } from "./mediaClient";

/** Outcome of the attach check: mirrors the server verdict's shape so
 *  call sites read the same way on both surfaces. */
export type AttachGuardVerdict = { ok: true } | { ok: false; error: string };

/**
 * Returns `checkAttach(candidate)`: may this asset be attached to the app
 * as it stands? Refuses a file the app's declared platforms cannot play,
 * and any file while the app's access is not authorized.
 *
 * Async because both attach entry points (library pick, staged-upload
 * confirm) dispatch from async handlers and treat it as one awaited step.
 */
export function useAttachGuard(): (
	candidate: MediaAssetView,
) => Promise<AttachGuardVerdict> {
	const docApi = useBlueprintDocApi();
	const session = useBuilderSessionApi();

	return useCallback(
		async (candidate: MediaAssetView) => {
			const state = session.getState();
			if (state.accessPhase !== "authorized")
				return {
					ok: false,
					error:
						"App access changed while checking this file. Choose it again.",
				};
			const platformError = attachPlatformSentence(
				candidate,
				declaredPlatforms(docApi.getState()),
			);
			if (platformError !== null) return { ok: false, error: platformError };
			// The candidate's own row is known-good metadata: record it so a
			// later reader (Preview's stand-in, a re-attach) needs no fetch.
			state.recordAssetMeta([candidate]);
			return { ok: true };
		},
		[docApi, session],
	);
}
