import { type MediaAssetView, uploadMediaAsset } from "./mediaClient";

export type MediaUploadStatus =
	| { state: "idle" }
	| { state: "uploading" }
	| { state: "error"; message: string };

/** The same live capability read gates both initiation and delivery. Each
 * replacement upload owns its own controller; a retired upload cannot publish. */
export function createMediaUpload(options: {
	appId?: string;
	canWrite: () => boolean;
}) {
	let state: MediaUploadStatus = { state: "idle" };
	let active = false;
	let controller: AbortController | null = null;
	const listeners = new Set<() => void>();
	function publish(next: MediaUploadStatus) {
		state = next;
		for (const notify of listeners) notify();
	}
	return {
		getSnapshot: () => state,
		subscribe: (notify: () => void) => {
			listeners.add(notify);
			return () => {
				listeners.delete(notify);
			};
		},
		start() {
			active = true;
		},
		stop() {
			active = false;
			controller?.abort();
			controller = null;
			publish({ state: "idle" });
		},
		async upload(file: File): Promise<MediaAssetView | null> {
			if (!active || !options.canWrite()) return null;
			controller?.abort();
			const ownController = new AbortController();
			controller = ownController;
			publish({ state: "uploading" });
			const owns = () =>
				active &&
				controller === ownController &&
				!ownController.signal.aborted &&
				options.canWrite();
			try {
				const asset = await uploadMediaAsset(file, {
					appId: options.appId,
					signal: ownController.signal,
				});
				if (!owns()) return null;
				publish({ state: "idle" });
				return asset;
			} catch (error) {
				if (!owns()) return null;
				publish({
					state: "error",
					message:
						error instanceof Error
							? error.message
							: "The upload failed for an unknown reason. Try again.",
				});
				return null;
			} finally {
				if (controller === ownController) {
					controller = null;
					if (active && !options.canWrite()) publish({ state: "idle" });
				}
			}
		},
	};
}
