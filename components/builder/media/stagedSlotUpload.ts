import type { MediaKind } from "@/lib/domain/multimedia";
import type { BuilderSessionStoreApi } from "@/lib/session/provider";
import { type MediaAssetView, uploadMediaAsset } from "./mediaClient";
import type { AttachBudgetVerdict } from "./useAttachBudget";

/** The transfer belongs to the Project; only its final attachment edits the
 * blueprint. A lost attachment destination never queues a later mutation. */
export async function uploadToStagedSlot({
	session,
	slotKey,
	kind,
	file,
	checkAttachBudget,
	onReady,
	onRetained,
}: {
	session: BuilderSessionStoreApi;
	slotKey: string;
	kind: MediaKind;
	file: File;
	checkAttachBudget: (asset: MediaAssetView) => Promise<AttachBudgetVerdict>;
	onReady: (asset: MediaAssetView) => void;
	onRetained: () => void;
}): Promise<void> {
	const start = session.getState();
	if (start.accessPhase !== "authorized" || !start.projectCanEdit) return;
	const controller = new AbortController();
	let destinationUnavailable = !start.canEdit;
	const ownsTransfer = () => {
		const state = session.getState();
		return (
			!controller.signal.aborted &&
			state.scopeEpoch === start.scopeEpoch &&
			state.projectId === start.projectId &&
			state.accessPhase === "authorized" &&
			state.projectCanEdit
		);
	};
	start.stageUpload(slotKey, {
		filename: file.name,
		kind,
		abort: () => controller.abort(),
	});
	const unsubscribe = session.subscribe((state) => {
		// Replacement and cancellation abort this transfer before clearing its
		// record. Never clear a replacement's slot from an old subscription.
		if (controller.signal.aborted) return;
		if (!ownsTransfer()) {
			state.cancelStagedUpload(slotKey);
			return;
		}
		if (!state.canEdit) destinationUnavailable = true;
	});
	const retainInLibrary = () => {
		if (!destinationUnavailable && session.getState().canEdit) return false;
		session.getState().clearStagedUpload(slotKey);
		onRetained();
		return true;
	};
	try {
		let asset: MediaAssetView;
		try {
			asset = await uploadMediaAsset(file, {
				signal: controller.signal,
				appId: start.appId,
				onProgress: (fraction) => {
					if (ownsTransfer())
						session.getState().setStagedUploadProgress(slotKey, fraction);
				},
			});
		} catch (error) {
			if (ownsTransfer())
				session
					.getState()
					.failStagedUpload(
						slotKey,
						error instanceof Error
							? error.message
							: "The upload failed for an unknown reason. Try again.",
					);
			return;
		}
		if (!ownsTransfer()) return;
		if (retainInLibrary()) return;
		let verdict: AttachBudgetVerdict;
		try {
			verdict = await checkAttachBudget(asset);
		} catch {
			// The file is already confirmed. A failed attachment check must
			// settle the chip just like a refusal, never strand an upload.
			if (!ownsTransfer() || retainInLibrary()) return;
			session
				.getState()
				.failStagedUpload(
					slotKey,
					"Your file was uploaded, but Nova couldn't check whether it could be attached. You can choose it from the library to try again.",
				);
			return;
		}
		if (!ownsTransfer()) return;
		if (retainInLibrary()) return;
		if (!verdict.ok) {
			session.getState().failStagedUpload(slotKey, verdict.error);
			return;
		}
		session.getState().clearStagedUpload(slotKey);
		onReady(asset);
	} finally {
		unsubscribe();
	}
}
