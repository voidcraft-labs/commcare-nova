// lib/media/uploadOutcome.ts
//
// Interprets CommCare HQ's bulk-multimedia-upload result into something a
// person can act on: which media didn't attach, WHERE it lives in the app,
// and whether the only thing missing is the app logo (which HQ never carries
// through a bulk upload by design).
//
// HQ reports `unmatched_files` as `{path, reason}` — the wire path of each
// file it couldn't match, plus a technical reason. This module joins the doc's
// reference walk (carrier → `AssetId`) with the manifest's asset → wire-path
// projection to turn each unmatched wire path back into its carrier(s), then
// partitions:
//
//   - logo-only unmatched  → EXPECTED. App-level media doesn't ride the bulk
//     upload (`carriesViaBulkUpload`), so a logo image used nowhere else always
//     comes back unmatched. Surfaced as a gentle heads-up, never an error.
//   - anything else        → a GENUINE failure worth investigating, named by
//     its carrier so the user sees exactly which media, where, didn't upload.
//
// `interpretMediaAttach` + `mediaAttachWarnings` are pure; `reportMediaAttach`
// is the side-effecting wrapper the upload route + MCP tool share — it returns
// the warning lines and emits the log decision (error for failures / warn for
// the logo case) in ONE place so the two call sites can't drift.

import type { BlueprintDoc } from "@/lib/domain";
import {
	type AssetRef,
	carriesViaBulkUpload,
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
	 * Media HQ genuinely couldn't attach — empty in the common case. Each
	 * names its carrier so the user isn't left with a bare count. The caller
	 * logs these loudly (Sentry) because, for non-logo media, an unmatched
	 * file shouldn't happen.
	 */
	readonly failures: readonly MediaAttachFailure[];
	/**
	 * The app logo is set but used ONLY as the logo, so CommCare HQ's bulk
	 * upload skipped it by design (app-level media isn't in the match set).
	 * Expected, not an error.
	 */
	readonly logoNotCarried: boolean;
}

/**
 * Partition HQ's unmatched-file report into the logo-by-design case and
 * genuine failures, resolving each genuine failure to its carrier.
 *
 * `assetWirePath` is the resolved manifest's asset → wire-path projection
 * (built by the caller, which owns the `lib/commcare` manifest); this module
 * joins it with the doc's reference walk to turn each unmatched wire path back
 * into the carrier(s) it serves. `hqErrors` are HQ's own processing-error
 * strings (separate from unmatched files), always treated as genuine failures
 * since they can't be pinned to a carrier.
 */
export function interpretMediaAttach(args: {
	readonly unmatched: readonly UnmatchedMediaFile[];
	readonly hqErrors: readonly string[];
	readonly assetWirePath: ReadonlyMap<string, string>;
	readonly doc: BlueprintDoc;
}): MediaAttachOutcome {
	const { unmatched, hqErrors, assetWirePath, doc } = args;

	// wire path → the carriers that reference it. Built by walking the doc's
	// references and projecting each asset to its wire path, so an asset reused
	// across several carriers (same image as logo AND a form icon) collects all
	// of them under one path.
	const refsByWirePath = new Map<string, AssetRef[]>();
	for (const ref of walkAssetRefs(doc)) {
		const wirePath = assetWirePath.get(ref.assetId);
		if (!wirePath) continue;
		const list = refsByWirePath.get(wirePath);
		if (list) list.push(ref);
		else refsByWirePath.set(wirePath, [ref]);
	}

	const failures: MediaAttachFailure[] = [];
	let logoNotCarried = false;

	for (const file of unmatched) {
		const refs = refsByWirePath.get(file.path) ?? [];

		// All carriers for this file are app-level (don't ride the bulk upload).
		// Expected — not a failure.
		if (
			refs.length > 0 &&
			refs.every((r) => !carriesViaBulkUpload(r.location))
		) {
			logoNotCarried = true;
			continue;
		}

		const where =
			refs.length > 0
				? CARRIER_LIST.format(refs.map(describeCarrier))
				: "an unrecognized media file";
		failures.push({ where, path: file.path, reason: file.reason });
	}

	// HQ processing errors are genuine, but carry no path to resolve.
	for (const reason of hqErrors) {
		failures.push({ where: "a media file", path: "", reason });
	}

	return { failures, logoNotCarried };
}

/**
 * The user-facing warning lines for a media-attach outcome — one per genuine
 * failure, plus a single gentle line when the logo won't carry. Empty when
 * everything attached.
 */
export function mediaAttachWarnings(outcome: MediaAttachOutcome): string[] {
	const lines: string[] = [];
	for (const f of outcome.failures) {
		lines.push(
			`Couldn't attach ${f.where} — CommCare HQ didn't recognize it during upload, so it won't display. Remove and re-add the file, then upload again.`,
		);
	}
	if (outcome.logoNotCarried) {
		lines.push(
			"Your logo image won't appear as the app logo — CommCare HQ doesn't apply a logo automatically on upload. Set it in CommCare HQ's app settings, or use the same image somewhere in a form so it's carried with the app.",
		);
	}
	return lines;
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
 * user-facing warnings, emitting the log decision in one place: genuine
 * failures mirror to Sentry (`log.error`) with each carrier + reason; the
 * standalone-logo case stays Cloud-Logging-only (`log.warn`). Returns the
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
		log.error(`${logPrefix} some media files did not attach`, {
			...logContext,
			matched: result.matched,
			unmatched: result.unmatched,
			failures: outcome.failures,
		});
	} else if (outcome.logoNotCarried) {
		log.warn(
			`${logPrefix} app logo not carried by bulk upload (used only as the logo)`,
			logContext,
		);
	} else {
		// Positive unmatched count but nothing resolvable — keep a signal.
		warnings.push(
			"Some media files may not have attached. The app was created — check its media in CommCare HQ.",
		);
		log.error(`${logPrefix} unmatched media reported without per-file detail`, {
			...logContext,
			matched: result.matched,
			unmatched: result.unmatched,
			errorCount: result.errors.length,
		});
	}
	return warnings;
}
