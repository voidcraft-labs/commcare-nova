// lib/media/uploadOutcome.ts
//
// Interprets CommCare HQ's bulk-multimedia-upload result into something a
// person can act on: which media didn't attach, and WHERE it lives in the
// app.
//
// HQ reports `unmatched_files` as `{path, reason}` — the wire path of each
// file it couldn't match, plus a technical reason. This module joins the doc's
// reference walk (carrier → `MediaAssetId`) with the manifest's asset → wire-path
// projection to turn each unmatched wire path back into its carrier(s), so
// the user sees exactly which media, where, didn't upload. Every unmatched
// file is a failure: the ZIP holds only files some carrier that rides the
// bulk upload references (`lib/domain/mediaRefs.ts::carriesViaBulkUpload`),
// so a file only the app logo uses is never sent and never comes back
// unmatched.
//
// `interpretMediaAttach` + `mediaAttachWarnings` are pure; `reportMediaAttach`
// is the side-effecting wrapper the upload route + MCP tool share — it returns
// the warning lines and emits the log decision in ONE place so the two call
// sites can't drift.

import type { BlueprintDoc } from "@/lib/domain";
import {
	type AssetRef,
	describeCarrier,
	walkAssetRefs,
} from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";

/** En-US conjunction list join ("A", "A and B", "A, B, and C") for the rare
 *  case of one shared image referenced by several carriers. */
const CARRIER_LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** One file CommCare HQ couldn't match, as reported by its status API. */
export interface UnmatchedMediaFile {
	/** Wire path of the ZIP entry HQ couldn't match (`commcare/<hash><ext>`). */
	readonly path: string;
	/** HQ's own reason string — technical, kept for server logs, never shown. */
	readonly reason: string;
}

/** A genuine attach failure, resolved to where it lives in the app. */
export interface MediaAttachFailure {
	/** Person-readable phrase for the carrier ("the app logo", "the image on …"). */
	readonly where: string;
	/** Wire path HQ reported (server logs only). */
	readonly path: string;
	/** HQ's raw reason (server logs only). */
	readonly reason: string;
}

export interface MediaAttachOutcome {
	/**
	 * Media HQ couldn't attach — empty in the common case. Each names its
	 * carrier so the user isn't left with a bare count. The caller logs
	 * these loudly (Sentry) because an unmatched file shouldn't happen.
	 */
	readonly failures: readonly MediaAttachFailure[];
}

/**
 * Resolve each file in HQ's unmatched-file report to the carriers it serves.
 *
 * `assetWirePath` is the resolved manifest's asset → wire-path projection
 * (built by the caller, which owns the `lib/commcare` manifest); this module
 * joins it with the doc's reference walk to turn each unmatched wire path back
 * into the carrier(s) it serves. `hqErrors` are HQ's own processing-error
 * strings (separate from unmatched files), always failures that can't be
 * pinned to a carrier.
 */
export function interpretMediaAttach(args: {
	readonly unmatched: readonly UnmatchedMediaFile[];
	readonly hqErrors: readonly string[];
	readonly assetWirePath: ReadonlyMap<string, string>;
	readonly doc: BlueprintDoc;
}): MediaAttachOutcome {
	const { unmatched, hqErrors, assetWirePath, doc } = args;

	// wire path → the carriers that reference it. Built by walking the doc's
	// references and projecting each asset to its wire path, so an asset
	// reused across several carriers (same image as logo AND a form icon)
	// collects all of them under one path.
	const refsByWirePath = new Map<string, AssetRef[]>();
	for (const ref of walkAssetRefs(doc)) {
		const wirePath = assetWirePath.get(ref.assetId);
		if (!wirePath) continue;
		const list = refsByWirePath.get(wirePath);
		if (list) list.push(ref);
		else refsByWirePath.set(wirePath, [ref]);
	}

	const failures: MediaAttachFailure[] = unmatched.map((file) => {
		const refs = refsByWirePath.get(file.path) ?? [];
		const where =
			refs.length > 0
				? CARRIER_LIST.format(refs.map(describeCarrier))
				: "an unrecognized media file";
		return { where, path: file.path, reason: file.reason };
	});

	// HQ processing errors are genuine, but carry no path to resolve.
	for (const reason of hqErrors) {
		failures.push({ where: "a media file", path: "", reason });
	}

	return { failures };
}

/**
 * The user-facing warning lines for a media-attach outcome, one per
 * failure. Empty when everything attached.
 */
export function mediaAttachWarnings(outcome: MediaAttachOutcome): string[] {
	return outcome.failures.map(
		(f) =>
			`Couldn't attach ${f.where}. CommCare HQ didn't recognize it during upload, so it won't display. Remove and re-add the file, then upload again.`,
	);
}

/** The bulk-upload result fields `reportMediaAttach` reads. */
export interface MediaAttachResult {
	readonly matched: number;
	readonly unmatched: number;
	readonly unmatchedFiles: readonly UnmatchedMediaFile[];
	readonly errors: readonly string[];
}

/**
 * Reconcile a completed bulk-upload result against the app and produce the
 * user-facing warnings, emitting the log decision in one place: failures
 * mirror to Sentry (`log.error`) with each carrier + reason. Returns the
 * warning lines for the caller to append to its response.
 *
 * Self-guarding: returns `[]` when nothing was unmatched and no errors were
 * reported, so callers can invoke it unconditionally. The final branch is a
 * defensive net — HQ couples `unmatched_count` to `len(unmatched_files)`, so a
 * positive count with no per-file detail shouldn't occur, but a truncated or
 * proxied response must not vanish silently the way a list-only read would.
 *
 * `logPrefix` identifies the call site in logs (e.g. `[commcare/upload]`);
 * `logContext` carries the structured fields (domain, appId, …) every line
 * shares.
 */
export function reportMediaAttach(args: {
	readonly result: MediaAttachResult;
	readonly assetWirePath: ReadonlyMap<string, string>;
	readonly doc: BlueprintDoc;
	readonly logPrefix: string;
	readonly logContext: Record<string, unknown>;
}): string[] {
	const { result, assetWirePath, doc, logPrefix, logContext } = args;
	if (result.unmatched === 0 && result.errors.length === 0) return [];

	const outcome = interpretMediaAttach({
		unmatched: result.unmatchedFiles,
		hqErrors: result.errors,
		assetWirePath,
		doc,
	});
	const warnings = mediaAttachWarnings(outcome);

	if (outcome.failures.length > 0) {
		log.error(`${logPrefix} some media files did not attach`, undefined, {
			...logContext,
			matched: result.matched,
			unmatched: result.unmatched,
			failures: outcome.failures,
		});
	} else {
		// Positive unmatched count but nothing resolvable — keep a signal.
		warnings.push(
			"Some media files may not have attached. The app was published. Check its media in CommCare HQ.",
		);
		log.error(
			`${logPrefix} unmatched media reported without per-file detail`,
			undefined,
			{
				...logContext,
				matched: result.matched,
				unmatched: result.unmatched,
				errorCount: result.errors.length,
			},
		);
	}
	return warnings;
}
