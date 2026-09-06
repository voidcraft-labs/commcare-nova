import {
	type AssetKind,
	EXTRACTOR_VERSION,
	isDocumentKind,
	type MediaExtractStatus,
} from "@/lib/domain/multimedia";
import { type ExtractMeta, triggerAssetExtraction } from "./mediaClient";

export interface ExtractableAsset {
	id: string;
	kind: AssetKind;
	extract?: { status: MediaExtractStatus };
}

/** One asset's extraction observation. A build may own the request beyond the
 * observer's lifetime; otherwise stop() aborts it. Restarting an observation
 * never allows a retired request to publish into its successor. */
export function createDocumentExtraction({
	asset,
	enabled = true,
	signal,
	onExtracted,
	onProgress,
}: {
	asset: ExtractableAsset;
	enabled?: boolean;
	signal?: AbortSignal;
	onExtracted?: (extract: ExtractMeta) => void;
	onProgress?: (deltaChars: number) => void;
}) {
	const isDocument = isDocumentKind(asset.kind);
	let status: MediaExtractStatus | null = isDocument
		? (asset.extract?.status ?? null)
		: null;
	let active = false;
	let requestId = 0;
	let polls = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let owned: AbortController | undefined;
	let pending: Promise<void> | undefined;
	const listeners = new Set<() => void>();
	const eligible = () => active && enabled && isDocument && !signal?.aborted;
	const setStatus = (next: MediaExtractStatus) => {
		if (status === next) return;
		status = next;
		for (const listener of listeners) listener();
	};
	function clearPoll() {
		clearTimeout(timer);
		timer = undefined;
	}
	function schedulePoll() {
		timer = setTimeout(() => {
			timer = undefined;
			polls += 1;
			void request();
		}, 4000);
	}
	function complete(extract: ExtractMeta) {
		setStatus(extract.status);
		onExtracted?.(extract);
	}
	function request(): Promise<void> {
		if (!eligible()) return Promise.resolve();
		if (pending) return pending;
		setStatus("extracting");
		const id = ++requestId;
		pending = triggerAssetExtraction(asset.id, {
			signal: signal ?? owned?.signal,
			onProgress: (delta) => {
				// Build-owned progress survives removal of its chip. Local observers
				// and superseded requests stop producing progress immediately.
				if (id === requestId && (active || (signal && !signal.aborted)))
					onProgress?.(delta);
			},
		})
			.then((extract) => {
				if (id !== requestId || !eligible()) return;
				if (extract.status === "ready" || extract.status === "failed") {
					complete(extract);
				} else if (polls < 75) {
					schedulePoll();
				} else {
					// A bounded observer must leave Reading when its five-minute budget
					// ends, so the user can retry or remove the staged document.
					complete({
						status: "failed",
						version: EXTRACTOR_VERSION,
						truncated: false,
						charCount: 0,
					});
				}
			})
			.finally(() => {
				if (id === requestId) pending = undefined;
			});
		return pending;
	}
	function stop() {
		active = false;
		clearPoll();
		owned?.abort();
		owned = undefined;
		if (!signal) {
			requestId += 1;
			pending = undefined;
		}
		signal?.removeEventListener("abort", stop);
	}
	return {
		getSnapshot: () => status,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		start(): Promise<void> {
			if (active) return pending ?? Promise.resolve();
			active = true;
			if (!eligible()) return Promise.resolve();
			signal?.addEventListener("abort", stop, { once: true });
			if (!signal) owned = new AbortController();
			if (pending) return pending;
			if (status === "ready" || status === "failed") return Promise.resolve();
			if (status === "extracting") {
				schedulePoll();
				return Promise.resolve();
			}
			return request();
		},
		retry(): Promise<void> {
			if (!eligible()) return Promise.resolve();
			clearPoll();
			polls = 0;
			return request();
		},
		stop,
	};
}
