// components/builder/media/useMedia.ts
//
// React hooks wrapping the `mediaClient` fetch layer with local
// state. Two hooks, colocated because they share the same data
// shape and are always used together by the picker:
//
//  - `useMediaUpload` — drives one upload, exposing in-flight /
//    error status for the upload tab's UX.
//  - `useMediaLibrary` — paginates the Project's existing assets for
//    the library tab, with an `addUploaded` hook so a just-uploaded
//    asset appears at the top without a refetch.

"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssetKind } from "@/lib/domain/multimedia";
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
}

export function useMediaUpload(appId?: string): UseMediaUpload {
	const [status, setStatus] = useState<MediaUploadStatus>({ state: "idle" });

	const upload = useCallback(
		async (file: File) => {
			setStatus({ state: "uploading" });
			try {
				// `appId` lands the asset in that app's Project (the chat composer in
				// the builder passes it so a chat document belongs to the same
				// Project the conversation resolves it under). Omitted by the
				// account-menu file manager — those go to the user's active Project.
				const asset = await uploadMediaAsset(file, { appId });
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
		},
		[appId],
	);

	return { upload, status };
}

export interface UseMediaLibrary {
	assets: MediaAssetView[];
	isLoading: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore: () => void;
	/** Prepend a just-uploaded asset so it shows immediately (deduped by id). */
	addUploaded: (asset: MediaAssetView) => void;
	/** Drop a just-deleted asset from the list so it disappears immediately. */
	removeAsset: (assetId: string) => void;
	/** Merge a partial update into a loaded asset in place — used to fold a freshly
	 *  completed extract (title/summary) into the list without a re-fetch, so the
	 *  preview opened from the library is current within the same session. */
	updateAsset: (assetId: string, patch: Partial<MediaAssetView>) => void;
}

/**
 * One library fetch request: which kinds (as a stable comma-joined KEY, not the
 * array — see below), from which `cursor`, and whether the result appends (next
 * page) or replaces (fresh page). A single effect keys off this object, so each
 * request maps to exactly one fetch — a kinds change and a `loadMore` both
 * produce one new request, never the double-fire two keyed effects would cause.
 */
interface LibraryRequest {
	/** The allowed kinds, sorted + comma-joined (`""` = every kind). A primitive
	 *  so `request` object identity only changes when we deliberately reset it. */
	kindsKey: string;
	cursor: string | undefined;
	append: boolean;
}

/** Reconstruct the kinds array from the stable request key (`""` → undefined). */
function kindsFromKey(key: string): AssetKind[] | undefined {
	return key ? (key.split(",") as AssetKind[]) : undefined;
}

/**
 * Paginated view of the Project's `ready` assets, optionally filtered to a SET of
 * `kinds`. Fetches the first page on mount and whenever the kinds change;
 * `loadMore` appends the next page via the opaque cursor. `appId` (when set)
 * resolves the app's Project as the tenant; absent, the server falls back to the
 * caller's active Project — so the standalone file manager browses the latter.
 *
 * Keying is by a STABLE STRING, not the `kinds` array: the picker computes a
 * fresh `[filter]` array each render, so a reference compare would reset the
 * request every render → infinite re-render. Sorting + joining the kinds yields
 * a primitive that's identical across renders for the same set (and order-
 * independent, so `["pdf","image"]` and `["image","pdf"]` are one page).
 *
 * The kinds reset is done by deriving a fresh page-0 request DURING render (the
 * `trackedKey` compare) rather than in a second effect — that keeps it to one
 * fetch per change with no mount double-fetch. The fetch effect guards
 * setState-after-unmount with a per-run `cancelled` flag so a fetch resolving
 * after the picker closes doesn't leak a state update (or trip the leak gate).
 */
export function useMediaLibrary(
	kinds?: readonly AssetKind[],
	appId?: string,
): UseMediaLibrary {
	const kindsKey = kinds && kinds.length > 0 ? [...kinds].sort().join(",") : "";

	const [assets, setAssets] = useState<MediaAssetView[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState<LibraryRequest>({
		kindsKey,
		cursor: undefined,
		append: false,
	});

	// Derived-state-during-render: when the kinds key changes, issue a fresh
	// page-0 request synchronously (no separate effect, so no double-fetch).
	// React re-renders before commit when setState fires during render, so the
	// fetch effect sees only the new request.
	const [trackedKey, setTrackedKey] = useState(kindsKey);
	if (trackedKey !== kindsKey) {
		setTrackedKey(kindsKey);
		setRequest({ kindsKey, cursor: undefined, append: false });
	}

	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		fetchMediaLibrary({
			kinds: kindsFromKey(request.kindsKey),
			cursor: request.cursor,
			appId,
		})
			.then((page) => {
				if (cancelled) return;
				setAssets((prev) =>
					request.append ? [...prev, ...page.assets] : page.assets,
				);
				setNextCursor(page.nextCursor);
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
	}, [request, appId]);

	const loadMore = useCallback(() => {
		if (isLoading || !nextCursor) return;
		setRequest((r) => ({
			kindsKey: r.kindsKey,
			cursor: nextCursor,
			append: true,
		}));
	}, [isLoading, nextCursor]);

	const addUploaded = useCallback((asset: MediaAssetView) => {
		setAssets((prev) =>
			prev.some((a) => a.id === asset.id) ? prev : [asset, ...prev],
		);
	}, []);

	const removeAsset = useCallback((assetId: string) => {
		setAssets((prev) => prev.filter((a) => a.id !== assetId));
	}, []);

	const updateAsset = useCallback(
		(assetId: string, patch: Partial<MediaAssetView>) => {
			setAssets((prev) =>
				prev.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
			);
		},
		[],
	);

	return {
		assets,
		isLoading,
		error,
		hasMore: nextCursor !== null,
		loadMore,
		addUploaded,
		removeAsset,
		updateAsset,
	};
}
