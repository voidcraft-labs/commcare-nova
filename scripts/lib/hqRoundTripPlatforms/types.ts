/**
 * The platforms cutover's shared vocabulary: its step ids in their one order,
 * its blocker and stop codes, and the content-free shapes of the plan (part
 * 09 §5, §6, §11 of step 4's plan, the registry these strings are spelled
 * in). Every other module of the cutover imports these names and never
 * redefines them.
 *
 * What reaches the report is content-free: step ids, feature ids, formats,
 * causes, carriers, codes, ids and counts. Names and file names live only in
 * the notice entries, which reach the notice row and the digest as hashed
 * bytes, never the report.
 */

import type { MediaFormatValue } from "@/lib/domain/multimedia";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";

/** The cutover id its notice rows carry. */
export const CUTOVER = "hq-round-trip-platforms";
/** The durable actor of every batch the cutover writes. */
export const ACTOR_ID = "system:hq-round-trip-platforms";
/** The reason the synthetic writer requires; it is not stored. */
export const ACTOR_REASON =
	"Record where the app runs, and make its questions and media run there";
/** The plan's format, part of its digest. */
export const PLAN_FORMAT = "hq-round-trip-platforms-1";

/** One app's batch id: the latch `UNIQUE (app_id, batch_id)` holds. */
export function batchIdOf(appId: string): string {
	return `${CUTOVER}:${appId}`;
}

/** The four steps of §5, in the one order they run in. */
export const PLATFORMS_STEP_IDS = [
	"declare-platforms",
	"remove-unplayed-media",
	"judge-target",
	"deployment-lines",
] as const;
export type PlatformsStepId = (typeof PLATFORMS_STEP_IDS)[number];

/** The app blockers of §11, each stopping the cutover before its first write. */
export const CUTOVER_BLOCKER_CODES = [
	"runs-on-neither",
	"datetime-split-refused",
	"media-row-missing",
	"transform-admission",
	"target-parse",
	"target-gate",
	"target-export-readiness",
	"not-representable",
	"case-schema-changed",
	"not-idempotent",
] as const;
export type CutoverBlockerCode = (typeof CUTOVER_BLOCKER_CODES)[number];

/** Stops that are no app's (§11): what a run reports beside `blocker`. */
export const CUTOVER_STOP_CODES = [
	"holder",
	"app-changed",
	"media-changed",
	"digest",
	"ledger",
	"error",
] as const;
export type CutoverStopCode = (typeof CUTOVER_STOP_CODES)[number];

/**
 * One blocker code of one app, content-free. `findingCodes` holds, sorted
 * and distinct, the feature ids a declaration blocker names (each as
 * `web-apps:<id>` or `android:<id>`), the validator codes of a target finding
 * (`CODE`, with `CODE:reason` for its `details.reason` and
 * `CODE:checkCode:checkReason` for an expression finding's checker code), or
 * the admission issue a step met.
 */
export interface CutoverBlocker {
	readonly code: CutoverBlockerCode;
	readonly count: number;
	readonly findingCodes: readonly string[];
}

/**
 * One change a step plans, content-free: its step, the entity it touches
 * (absent for the app itself) and its details as ids and counts.
 */
export interface PlannedChange {
	readonly step: PlatformsStepId;
	readonly entityUuid: string | null;
	readonly detail: Readonly<Record<string, string | number>>;
}

/** Why a ready media row holds the format it does (§7). */
export const MEDIA_CAUSES = [
	"mime",
	"classified",
	"no-variant",
	"missing",
	"too-large",
] as const;
export type MediaCause = (typeof MEDIA_CAUSES)[number];

/** One ready image, audio or video row and the format the backfill gives it. */
export interface MediaPlan {
	readonly assetId: string;
	readonly projectId: string;
	/** `canonicalJsonDigest` of the row's status, kind, mime_type, extension, content_hash and gcs_object_key. */
	readonly rowDigest: string;
	/** The row's `mime_type`, for the references' labels. */
	readonly mimeType: string;
	readonly format: MediaFormatValue;
	readonly cause: MediaCause;
}

/** Why a reference step 2 removes was removed, as its notice line says. */
export type RemovalCause =
	| "web-apps"
	| "android"
	| "neither"
	| "missing"
	| "too-large";

/** One app's part of the plan. */
export interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	readonly baseSeq: number;
	/** `canonicalJsonDigest` of the source's persistable doc. */
	readonly baseDigest: string;
	/** Null where a blocker stopped step 1. */
	readonly declaration: "both" | "web-apps" | "android" | null;
	/** Null where the app writes nothing. */
	readonly targetDigest: string | null;
	readonly changes: readonly PlannedChange[];
	/** Empty where the app gets no notice row. */
	readonly notice: readonly MigrationNoticeEntry[];
	readonly blockers: readonly CutoverBlocker[];
}

export interface PlatformsCutoverPlan {
	readonly format: typeof PLAN_FORMAT;
	/** Every ready image, audio and video row, by asset id. */
	readonly media: readonly MediaPlan[];
	/** Every app, deleted ones included, in code-point order of id. */
	readonly apps: readonly AppPlan[];
	/** `canonicalJsonDigest` of `{ format, media, apps }`. */
	readonly digest: string;
}

/** Code-point order, so nothing depends on the database's collation. */
export function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
