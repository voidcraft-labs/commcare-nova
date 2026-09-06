"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useReconcilerContext } from "@/lib/collab/context";
import type { AssetKind } from "@/lib/domain/multimedia";
import {
	useAccessPhase,
	useCanEdit,
	useProjectScopeEpoch,
} from "@/lib/session/hooks";
import { useOptionalBuilderSessionApi } from "@/lib/session/provider";
import type { MediaAssetView } from "./mediaClient";
import { createMediaLibrary } from "./mediaLibrary";
import { createMediaUpload, type MediaUploadStatus } from "./mediaUpload";

export type { MediaUploadStatus } from "./mediaUpload";
export interface UseMediaUpload {
	upload: (file: File) => Promise<MediaAssetView | null>;
	status: MediaUploadStatus;
}

export function useMediaUpload(appId?: string): UseMediaUpload {
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();
	const canEdit = useCanEdit();
	const session = useOptionalBuilderSessionApi();
	const reconciler = useReconcilerContext();
	const model = useMemo(
		() =>
			createMediaUpload({
				appId,
				canWrite: () => {
					const live = session?.getState();
					return live
						? live.accessPhase === "authorized" &&
								live.canEdit &&
								live.scopeEpoch === scopeEpoch
						: accessPhase === "authorized" && canEdit;
				},
			}),
		[appId, session, scopeEpoch, accessPhase, canEdit],
	);
	const status = useSyncExternalStore(
		model.subscribe,
		model.getSnapshot,
		model.getSnapshot,
	);
	useEffect(() => {
		const unsubscribe = reconciler?.subscribeProjectScopeReset(model.stop);
		model.start();
		return () => {
			unsubscribe?.();
			model.stop();
		};
	}, [model, reconciler]);
	return { upload: model.upload, status };
}

export interface UseMediaLibrary {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore: () => void;
	retry: () => void;
	addUploaded: (asset: MediaAssetView) => void;
	removeAsset: (assetId: string) => void;
	updateAsset: (assetId: string, patch: Partial<MediaAssetView>) => void;
}

/** React binds one immutable query/app/Project scope to the observable model.
 * Equivalent kind sets and trimmed searches keep the same model and request. */
export function useMediaLibrary(
	kinds?: readonly AssetKind[],
	appId?: string,
	query?: string,
): UseMediaLibrary {
	const kindsKey = [...new Set(kinds)].sort().join(",");
	const normalizedQuery = query?.trim() || undefined;
	const scopeEpoch = useProjectScopeEpoch();
	const accessPhase = useAccessPhase();
	const reconciler = useReconcilerContext();
	// biome-ignore lint/correctness/useExhaustiveDependencies: a Project epoch owns a new model even when the app and query are unchanged
	const model = useMemo(
		() =>
			createMediaLibrary({
				kinds: kindsKey ? (kindsKey.split(",") as AssetKind[]) : undefined,
				appId,
				query: normalizedQuery,
				authorized: accessPhase === "authorized",
			}),
		[kindsKey, appId, normalizedQuery, accessPhase, scopeEpoch],
	);
	const state = useSyncExternalStore(
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
	const loadMore = useCallback(() => {
		void model.loadMore();
	}, [model]);
	const retry = useCallback(() => {
		void model.retry();
	}, [model]);
	return {
		...state,
		loadMore,
		retry,
		addUploaded: model.addUploaded,
		removeAsset: model.removeAsset,
		updateAsset: model.updateAsset,
	};
}
