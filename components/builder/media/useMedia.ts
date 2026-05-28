// components/builder/media/useMedia.ts
//
// React hooks wrapping the `mediaClient` fetch layer with local
// state. Two hooks, colocated because they share the same data
// shape and are always used together by the picker:
//
//  - `useMediaUpload` — drives one upload, exposing in-flight /
//    error status for the upload tab's UX.
//  - `useMediaLibrary` — paginates the owner's existing assets for
//    the library tab, with an `addUploaded` hook so a just-uploaded
//    asset appears at the top without a refetch.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaKind } from "@/lib/domain/multimedia";
import {
	fetchMediaLibrary,
	type MediaAssetView,
	uploadMediaAsset,
} from "./mediaClient";

/** Upload lifecycle, surfaced so the dialog can show progress + errors. */
export type MediaUploadStatus =
	| { state: "idle" }
	| { state: "uploading" }
	| { state: "error"; message: string };

export interface UseMediaUpload {
	/** Run an upload; resolves to the asset, or `null` if it failed (see `status`). */
	upload: (file: File) => Promise<MediaAssetView | null>;
	status: MediaUploadStatus;
	reset: () => void;
}

export function useMediaUpload(): UseMediaUpload {
	const [status, setStatus] = useState<MediaUploadStatus>({ state: "idle" });

	const upload = useCallback(async (file: File) => {
		setStatus({ state: "uploading" });
		try {
			const asset = await uploadMediaAsset(file);
			setStatus({ state: "idle" });
			return asset;
		} catch (err) {
			setStatus({
				state: "error",
				message:
					err instanceof Error
						? err.message
						: "The upload failed for an unknown reason. Try again.",
			});
			return null;
		}
	}, []);

	const reset = useCallback(() => setStatus({ state: "idle" }), []);

	return { upload, status, reset };
}

export interface UseMediaLibrary {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore: () => void;
	/** Prepend a just-uploaded asset so it shows immediately (deduped by id). */
	addUploaded: (asset: MediaAssetView) => void;
}

/**
 * Paginated view of the owner's `ready` assets, optionally filtered
 * to one `kind`. Fetches the first page on mount (and whenever
 * `kind` changes); `loadMore` appends the next page via the opaque
 * cursor.
 *
 * The effect guards against setState-after-unmount with a
 * per-run `cancelled` flag so an in-flight fetch resolving after
 * the picker closes doesn't leak a state update (or trip the
 * async-leak gate).
 */
export function useMediaLibrary(kind?: MediaKind): UseMediaLibrary {
	const [assets, setAssets] = useState<MediaAssetView[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [hasMore, setHasMore] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Bumped to request the next page; the effect reads it so
	// `loadMore` doesn't have to re-implement the fetch.
	const [pageRequest, setPageRequest] = useState(0);
	const cursorRef = useRef<string | null>(null);

	// Reset and refetch from the top whenever the kind filter changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetting on `kind` change is the intent
	useEffect(() => {
		setAssets([]);
		setCursor(null);
		cursorRef.current = null;
		setHasMore(false);
		setPageRequest(0);
	}, [kind]);

	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		fetchMediaLibrary({
			kind,
			cursor: pageRequest === 0 ? undefined : (cursorRef.current ?? undefined),
		})
			.then((page) => {
				if (cancelled) return;
				setAssets((prev) =>
					pageRequest === 0 ? page.assets : [...prev, ...page.assets],
				);
				setCursor(page.nextCursor);
				cursorRef.current = page.nextCursor;
				setHasMore(page.nextCursor !== null);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(
					err instanceof Error
						? err.message
						: "Couldn't load your media library.",
				);
			})
			.finally(() => {
				if (!cancelled) setIsLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [kind, pageRequest]);

	const loadMore = useCallback(() => {
		if (isLoading || !cursor) return;
		setPageRequest((n) => n + 1);
	}, [isLoading, cursor]);

	const addUploaded = useCallback((asset: MediaAssetView) => {
		setAssets((prev) =>
			prev.some((a) => a.id === asset.id) ? prev : [asset, ...prev],
		);
	}, []);

	return { assets, isLoading, error, hasMore, loadMore, addUploaded };
}
