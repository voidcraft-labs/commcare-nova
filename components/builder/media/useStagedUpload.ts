// components/builder/media/useStagedUpload.ts
//
// The slot-upload driver: the one place a picked file becomes a staged
// session record, a running upload, and — on confirm — a gated attach.
//
// The contract it implements: the doc never references an asset that
// isn't `ready`. A file picked for a slot is therefore STAGED in the
// session store (`stagedUploads` — progress + cancel, never doc state)
// while the hash → signed-PUT → confirm flow runs; only the confirm
// response (whose asset is `ready` by definition) dispatches the slot's
// normal gated attach via `onReady`. A failure flips the staged record
// to its error state with nothing ever committed; a cancel aborts the
// transfer and removes the record.
//
// The staged record lives in the session store (not component state) so
// a slot that unmounts mid-upload — the user closes the settings panel,
// navigates within the builder — re-renders its chip from the store on
// remount, and cancel still reaches the transfer through the store's
// abort registry. The confirm-time attach goes through an `onReady` ref
// updated every render, so it dispatches against the carrier's CURRENT
// value, not the one captured when the upload began.
//
// The confirm also runs the attach budget check (`useAttachBudget.ts`)
// BEFORE dispatching: a confirmed upload that would push the app past
// the media export ceiling lands in the library (the bytes are valid)
// but does NOT attach — the staged chip flips to the shared rejection
// prose with nothing committed.

"use client";

import { useCallback, useEffect, useRef } from "react";
import type { MediaKind } from "@/lib/domain/multimedia";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { type MediaAssetView, uploadMediaAsset } from "./mediaClient";
import { useAttachBudgetGuard } from "./useAttachBudget";

/**
 * Drive staged uploads for one carrier slot family. `onReady` receives
 * the CONFIRMED (ready) asset plus the kind it was staged under — the
 * slot dispatches its gated attach there.
 *
 * Returns `start(slotKey, kind, file)`: stages the record under
 * `slotKey` and runs the upload. The picker's kind validation has
 * already run by the time a file reaches this.
 */
export function useStagedSlotUpload(
	onReady: (asset: MediaAssetView, kind: MediaKind) => void,
): (slotKey: string, kind: MediaKind, file: File) => void {
	const session = useBuilderSessionApi();
	const checkAttachBudget = useAttachBudgetGuard();
	const onReadyRef = useRef(onReady);
	useEffect(() => {
		onReadyRef.current = onReady;
	});

	return useCallback(
		(slotKey: string, kind: MediaKind, file: File) => {
			const controller = new AbortController();
			const actions = session.getState();
			actions.stageUpload(slotKey, {
				filename: file.name,
				kind,
				abort: () => controller.abort(),
			});
			uploadMediaAsset(file, {
				signal: controller.signal,
				onProgress: (fraction) =>
					session.getState().setStagedUploadProgress(slotKey, fraction),
				// Land the asset in the app owner's shared namespace so every
				// Project member draws from one pool (and compile resolves it).
				appId: actions.appId,
			}).then(
				async (asset) => {
					/* Confirm flipped the row to ready. Budget BEFORE dispatch:
					 * the upload itself succeeded (the file is in the library),
					 * but an attach that would breach the export ceiling refuses
					 * here — the shared prose lands on the staged chip and
					 * nothing was ever committed. A cancel that raced the check
					 * wins (the record is gone; stay silent). */
					const verdict = await checkAttachBudget(asset);
					if (controller.signal.aborted) return;
					if (!verdict.ok) {
						session.getState().failStagedUpload(slotKey, verdict.error);
						return;
					}
					session.getState().clearStagedUpload(slotKey);
					onReadyRef.current(asset, kind);
				},
				(err: unknown) => {
					/* Cancel already removed the record (cancelStagedUpload aborts
					 * then clears) — stay silent so the cleared slot doesn't
					 * resurrect as an error chip. */
					if (controller.signal.aborted) return;
					session
						.getState()
						.failStagedUpload(
							slotKey,
							err instanceof Error
								? err.message
								: "The upload failed for an unknown reason. Try again.",
						);
				},
			);
		},
		[session, checkAttachBudget],
	);
}
