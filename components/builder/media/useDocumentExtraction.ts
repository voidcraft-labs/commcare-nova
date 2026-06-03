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

/** How often to re-check an extraction another request owns (saw a 202). */
const POLL_INTERVAL_MS = 4000;
/** Cap the poll loop so a job that never converges (abandoned mid-extraction)
 *  stops spinning rather than polling forever — ~5 min, past the route's
 *  `maxDuration`. The chat's lazy backstop re-reads the document on send. */
const MAX_POLLS = 75;

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

	// Cancel-safety: a long-running POST or a queued poll must not write state
	// after unmount. The cleanup flips the flag and clears any pending poll.
	const cancelledRef = useRef(false);
	const pollTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const pollCountRef = useRef(0);
	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
			clearTimeout(pollTimerRef.current);
		};
	}, []);

	/**
	 * POST the extract route and reflect the result. The route runs extraction
	 * to completion for the first caller (resolving `ready`/`failed`), but a
	 * concurrent caller gets `extracting` (202) — so when WE see `extracting`,
	 * another request owns the job and we must POLL to observe its terminal
	 * state, or this instance is stuck on "Reading…" forever. Polling re-POSTs
	 * (cheap: the route short-circuits an in-flight extraction with 202 and a
	 * completed one with `ready`); capped so a never-converging job stops
	 * spinning rather than polling indefinitely.
	 */
	const poll = useCallback(() => {
		triggerAssetExtraction(asset.id).then((next) => {
			if (cancelledRef.current) return;
			setStatus(next);
			if (next === "extracting" && pollCountRef.current < MAX_POLLS) {
				pollCountRef.current += 1;
				pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
			}
		});
	}, [asset.id]);

	const run = useCallback(() => {
		clearTimeout(pollTimerRef.current);
		pollCountRef.current = 0;
		setStatus("extracting");
		poll();
	}, [poll]);

	// Decide the once-per-mount action for a document. `ready`/`failed` are
	// TERMINAL stored states — show them and do nothing (a failed doc must NOT
	// silently re-run the model on every file-manager open; the badge's Retry is
	// the only re-run path). An `extracting` stored state means a job is already
	// in flight server-side, so converge on it via the poll WITHOUT starting a
	// fresh run. Only a never-attempted document kicks off extraction here.
	const triggeredRef = useRef(false);
	useEffect(() => {
		if (!isDoc || triggeredRef.current) return;
		triggeredRef.current = true;
		const stored = asset.extract?.status;
		if (stored === "ready" || stored === "failed") {
			setStatus(stored);
			return;
		}
		if (stored === "extracting") {
			setStatus("extracting");
			pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
			return;
		}
		run();
	}, [isDoc, asset.extract?.status, run, poll]);

	return { status, retry: run };
}
