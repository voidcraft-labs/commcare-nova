// components/builder/media/useStagedUpload.ts
//
// The slot-upload driver: the one place a picked file becomes a staged
// session record, a running upload, and: on confirm, a gated attach.
//
// The contract it implements: the doc never references an asset that
// isn't `ready`. A file picked for a slot is therefore STAGED in the
// session store (`stagedUploads`: progress + cancel, never doc state)
// while the hash → signed-PUT → confirm flow runs; only the confirm
// response (whose asset is `ready` by definition) dispatches the slot's
// normal gated attach via `onReady`. A failure flips the staged record
// to its error state with nothing ever committed; a cancel aborts the
// transfer and removes the record.
// Upload authority belongs to the Project. If blueprint editing becomes
// unavailable, the upload still finishes into the library, the staged record
// clears, and a notice explains how to choose the file later. No attachment
// waits for editing to return.
//
// The staged record lives in the session store (not component state) so
// a slot that unmounts mid-upload: the user closes the settings panel,
// navigates within the builder: re-renders its chip from the store on
// remount, and cancel still reaches the transfer through the store's
// abort registry. The confirm-time attach goes through an `onReady` ref
// updated every render, so it dispatches against the carrier's CURRENT
// value, not the one captured when the upload began.
//
// The confirm also runs the attach budget check (`useAttachBudget.ts`)
// BEFORE dispatching: a confirmed upload that would push the app past
// the media export ceiling lands in the library (the bytes are valid)
// but does NOT attach: the staged chip flips to the shared rejection
// prose with nothing committed.

"use client";

import { useCallback, useEffect, useRef } from "react";
import { useProjectToast } from "@/lib/collab/useProjectToast";
import type { MediaKind } from "@/lib/domain/multimedia";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { MediaAssetView } from "./mediaClient";
import { uploadToStagedSlot } from "./stagedSlotUpload";
import { useAttachBudgetGuard } from "./useAttachBudget";

/**
 * Drive staged uploads for one carrier slot family. `onReady` receives
 * the CONFIRMED (ready) asset plus the kind it was staged under, the
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
	const projectToast = useProjectToast();
	const onReadyRef = useRef(onReady);
	useEffect(() => {
		onReadyRef.current = onReady;
	});

	return useCallback(
		(slotKey: string, kind: MediaKind, file: File) =>
			uploadToStagedSlot({
				session,
				slotKey,
				kind,
				file,
				checkAttachBudget,
				onReady: (asset) => onReadyRef.current(asset, kind),
				onRetained: () => {
					projectToast(
						"info",
						"File uploaded to your library",
						"It couldn't be attached while app editing was unavailable. You can choose it from the library when editing is available.",
					);
				},
			}),
		[session, checkAttachBudget, projectToast],
	);
}
