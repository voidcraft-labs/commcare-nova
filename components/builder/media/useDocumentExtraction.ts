"use client";

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import type { MediaExtractStatus } from "@/lib/domain/multimedia";
import {
	createDocumentExtraction,
	type ExtractableAsset,
} from "./documentExtraction";
import type { ExtractMeta } from "./mediaClient";
import { useMediaAuthority } from "./useMediaAuthority";

export type { ExtractableAsset } from "./documentExtraction";

export interface DocumentExtraction {
	status: MediaExtractStatus | null;
	retry: () => void;
}

/** React observes one asset's state model. The supplied signal belongs to the
 * build, so its request can outlive a chip; without it, the observer owns the
 * request and cancels when removed. Viewers never start, poll, or retry. */
export function useDocumentExtraction(
	asset: ExtractableAsset,
	onExtracted?: (extract: ExtractMeta) => void,
	onProgress?: (deltaChars: number) => void,
	abortSignal?: AbortSignal,
	enabled = true,
): DocumentExtraction {
	const reconciler = useReconcilerContext();
	const { canManageFiles, mayManageFiles } = useMediaAuthority(enabled);
	const callbacks = useRef({ onExtracted, onProgress });
	callbacks.current = { onExtracted, onProgress };
	const { id, kind } = asset;
	const storedStatus = asset.extract?.status;
	const model = useMemo(
		() =>
			createDocumentExtraction({
				asset: {
					id,
					kind,
					extract: storedStatus ? { status: storedStatus } : undefined,
				},
				enabled: enabled && canManageFiles,
				mayExtract: mayManageFiles,
				signal: abortSignal,
				onExtracted: (extract) => callbacks.current.onExtracted?.(extract),
				onProgress: (delta) => callbacks.current.onProgress?.(delta),
			}),
		[
			id,
			kind,
			storedStatus,
			enabled,
			canManageFiles,
			mayManageFiles,
			abortSignal,
		],
	);
	const status = useSyncExternalStore(
		model.subscribe,
		model.getSnapshot,
		model.getSnapshot,
	);
	useEffect(() => {
		const unsubscribe = reconciler?.subscribeProjectScopeReset(model.stop);
		void model.start();
		return () => {
			unsubscribe?.();
			model.stop();
		};
	}, [model, reconciler]);
	const retry = useCallback(() => {
		void model.retry();
	}, [model]);
	return { status, retry };
}
