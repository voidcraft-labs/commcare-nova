// components/builder/media/useDocumentExtraction.ts
//
// Drives the feature-extraction lifecycle for ONE asset, so the file-manager +
// composer can show whether the assistant has read a document yet. Extraction
// runs server-side (POST /api/media/[id]/extract); this kicks it off when a
// document has no current extract and tracks the resulting status.
//
// Non-documents (images / audio / video) have no extract — the hook reports
// `null` and does nothing for them. A `ready` document is left alone (already
// read). Anything else (never extracted, a prior failure, a stale version) is
// (re)triggered once on mount; `retry` re-runs a failed one on demand.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
	type AssetKind,
	isDocumentKind,
	type MediaExtractStatus,
} from "@/lib/domain/multimedia";
import { triggerAssetExtraction } from "./mediaClient";

/** The minimal asset shape the hook reads — id, kind, and the persisted extract
 *  status (absent until extraction has run). Both `MediaAssetView` and a freshly
 *  uploaded asset satisfy it. */
export interface ExtractableAsset {
	id: string;
	kind: AssetKind;
	extract?: { status: MediaExtractStatus };
}

export interface DocumentExtraction {
	/** `null` for a non-document (no extract concept); otherwise the live status. */
	status: MediaExtractStatus | null;
	/** Re-run extraction — wired to the "failed" badge's retry affordance. */
	retry: () => void;
}

export function useDocumentExtraction(
	asset: ExtractableAsset,
): DocumentExtraction {
	const isDoc = isDocumentKind(asset.kind);
	const [status, setStatus] = useState<MediaExtractStatus | null>(
		isDoc ? (asset.extract?.status ?? null) : null,
	);

	/** A single in-flight extraction, cancel-safe across unmount. */
	const cancelledRef = useRef(false);
	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
		};
	}, []);

	const run = useCallback(() => {
		setStatus("extracting");
		triggerAssetExtraction(asset.id).then((next) => {
			// The POST persists server-side even if this component unmounted; we
			// just don't write to dead state.
			if (!cancelledRef.current) setStatus(next);
		});
	}, [asset.id]);

	// Kick off extraction once when a document isn't already read. The server is
	// idempotent, so a redundant trigger (e.g. the same doc shown in two places)
	// collapses to a 202 / ready rather than re-running the model.
	const triggeredRef = useRef(false);
	useEffect(() => {
		if (!isDoc || triggeredRef.current) return;
		if (asset.extract?.status === "ready") {
			setStatus("ready");
			return;
		}
		triggeredRef.current = true;
		run();
	}, [isDoc, asset.extract?.status, run]);

	return { status, retry: run };
}
