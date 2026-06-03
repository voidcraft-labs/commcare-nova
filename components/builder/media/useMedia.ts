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
}

/**
 * One library fetch request: which `kind`, from which `cursor`, and
 * whether the result appends (next page) or replaces (fresh page).
 * A single effect keys off this object, so each request maps to
 * exactly one fetch — a kind change and a `loadMore` both produce
 * one new request, never the double-fire two kind-keyed effects
 * would cause.
 */
interface LibraryRequest {
	kind: AssetKind | undefined;
	cursor: string | undefined;
	append: boolean;
}

/**
 * Paginated view of the owner's `ready` assets, optionally filtered
 * to one `kind`. Fetches the first page on mount and whenever `kind`
 * changes; `loadMore` appends the next page via the opaque cursor.
 *
 * The kind reset is done by deriving a fresh page-0 request DURING
 * render (the `trackedKind` compare) rather than in a second effect —
 * that keeps it to one fetch per kind change with no mount
 * double-fetch. The fetch effect guards setState-after-unmount with
 * a per-run `cancelled` flag so a fetch resolving after the picker
 * closes doesn't leak a state update (or trip the async-leak gate).
 */
export function useMediaLibrary(kind?: AssetKind): UseMediaLibrary {
	const [assets, setAssets] = useState<MediaAssetView[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState<LibraryRequest>({
		kind,
		cursor: undefined,
		append: false,
	});

	// Derived-state-during-render: when the `kind` prop changes, issue a
	// fresh page-0 request synchronously (no separate effect, so no
	// double-fetch). React re-renders before commit when setState fires
	// during render, so the fetch effect sees only the new request.
	const [trackedKind, setTrackedKind] = useState(kind);
	if (trackedKind !== kind) {
		setTrackedKind(kind);
		setRequest({ kind, cursor: undefined, append: false });
	}

	useEffect(() => {
		let cancelled = false;
		setIsLoading(true);
		setError(null);
		fetchMediaLibrary({ kind: request.kind, cursor: request.cursor })
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
	}, [request]);

	const loadMore = useCallback(() => {
		if (isLoading || !nextCursor) return;
		setRequest((r) => ({ kind: r.kind, cursor: nextCursor, append: true }));
	}, [isLoading, nextCursor]);

	const addUploaded = useCallback((asset: MediaAssetView) => {
		setAssets((prev) =>
			prev.some((a) => a.id === asset.id) ? prev : [asset, ...prev],
		);
	}, []);

	return {
		assets,
		isLoading,
		error,
		hasMore: nextCursor !== null,
		loadMore,
		addUploaded,
	};
}
