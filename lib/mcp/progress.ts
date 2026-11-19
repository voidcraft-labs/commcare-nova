/**
 * MCP progress emitter.
 *
 * Adapters emit fine-grained progress through this interface so clients
 * with a progress token on their tool call can observe stage
 * transitions in real time. The stage taxonomy mirrors the chapter tags
 * emitted on `MutationEvent.stage`, so a UI consuming the stage
 * vocabulary shares one parser across the live stream and this surface.
 *
 * When the client did not opt into progress (no progress token),
 * `notify()` is a no-op — adapters can call it unconditionally without
 * branching on whether the caller is interested.
 *
 * Notifications carry the MCP-spec-required fields only: monotonically
 * increasing `progress`, and a human-readable `message` that encodes
 * both the machine-parseable stage tag and optional structured context
 * in a single string (format: `"[<stage>] <message>[ | <key>=<val>...]"`).
 * Clients that want to branch on stage parse the prefix; clients that
 * only render to a human use the whole message.
 */

import type { ReadingEvent, ReadingStage } from "@/lib/deployment";
import { HQ_CHANGES_STAGE_LABELS } from "@/lib/publish/hqChangesCopy";
import type { HqChangesStage } from "@/lib/publish/hqChangesKinds";
import { READING_STAGE_LABELS } from "@/lib/publish/hqReadingCopy";

/**
 * Stage vocabulary for MCP progress notifications. Mirrors the chapter
 * tags emitted on `MutationEvent.stage`, and beyond them the publish's
 * three, a bring-in's seven, one per `ReadingStage`, and the six of a
 * review or bring-in of changes made in CommCare HQ, one per
 * `HqChangesStage`. Additive — new
 * stages are added here alongside any new stage tag.
 */
export type ProgressStage =
	| "app_created"
	| "schema_generated"
	| "scaffold_generated"
	| "module_added"
	| "form_added"
	| "validation_started"
	| "validation_fix_applied"
	| "validation_passed"
	| "upload_started"
	| "resources_pushed"
	| "upload_complete"
	| ReadingProgressStage
	| HqChangesProgressStage;

/** A bring-in's stage as a progress tag: `hq_` and the stage, hyphens as underscores. */
type ReadingProgressStage = `hq_${Underscored<ReadingStage>}`;
type Underscored<S extends string> = S extends `${infer Head}-${infer Tail}`
	? `${Head}_${Underscored<Tail>}`
	: S;

/** Each `ReadingStage`'s tag, spelled out so the seven are a closed table. */
const READING_PROGRESS_TAGS: Readonly<
	Record<ReadingStage, ReadingProgressStage>
> = {
	connecting: "hq_connecting",
	"reading-app": "hq_reading_app",
	"reading-project-data": "hq_reading_project_data",
	checking: "hq_checking",
	"checking-media": "hq_checking_media",
	"bringing-in-media": "hq_bringing_in_media",
	creating: "hq_creating",
};

/** The fewest milliseconds between two file counts a sink sends. */
const FILE_COUNT_INTERVAL_MS = 1000;

/** A stage's label with no count: what a progress message says of it. */
function readingStageLabel(stage: ReadingStage): string {
	switch (stage) {
		case "checking-media":
		case "bringing-in-media":
			return READING_STAGE_LABELS[stage](null);
		default:
			return READING_STAGE_LABELS[stage];
	}
}

/**
 * The `onEvent` an MCP tool hands a bring-in. A `stage` event sends one
 * notification, tagged `hq_` and the stage with its hyphens as underscores,
 * its message the stage's label. A `files` event sends one under the tag of
 * the stage last named, with `done` and `total` as `extra`, at most one a
 * second, and always the one whose `done` is `total`. `done` and `failed`
 * events send nothing: the tool's result says them.
 *
 * `now` is the clock the interval is measured on, in milliseconds.
 */
export function readingProgressSink(
	emitter: ProgressEmitter,
	now: () => number = () => performance.now(),
): (event: ReadingEvent) => void {
	let stage: ReadingStage | null = null;
	let lastCountAt: number | null = null;
	return (event) => {
		switch (event.type) {
			case "stage":
				stage = event.stage;
				emitter.notify(
					READING_PROGRESS_TAGS[event.stage],
					readingStageLabel(event.stage),
				);
				return;
			case "files": {
				/* A count rides the stage that planned its files; one before any
				 * stage has no tag to go under. */
				if (stage === null) return;
				const at = now();
				const last = event.done === event.total;
				if (
					!last &&
					lastCountAt !== null &&
					at - lastCountAt < FILE_COUNT_INTERVAL_MS
				)
					return;
				lastCountAt = at;
				emitter.notify(READING_PROGRESS_TAGS[stage], readingStageLabel(stage), {
					done: event.done,
					total: event.total,
				});
				return;
			}
			case "done":
			case "failed":
				return;
		}
	};
}

/**
 * A stage of a review or a bring-in of changes made in CommCare HQ as a
 * progress tag: `hq_changes_` and the stage, hyphens as underscores, so a
 * client tells it from a bring-in of an app's stage of the same name.
 */
type HqChangesProgressStage = `hq_changes_${Underscored<HqChangesStage>}`;

/** Each `HqChangesStage`'s tag, spelled out so the six are a closed table. */
const HQ_CHANGES_PROGRESS_TAGS: Readonly<
	Record<HqChangesStage, HqChangesProgressStage>
> = {
	"reading-app": "hq_changes_reading_app",
	"reading-project-data": "hq_changes_reading_project_data",
	checking: "hq_changes_checking",
	"checking-media": "hq_changes_checking_media",
	"adding-media": "hq_changes_adding_media",
	"bringing-in": "hq_changes_bringing_in",
};

/** A stage's label with no count: what a progress message says of it. */
function hqChangesStageLabel(stage: HqChangesStage): string {
	return stage === "checking-media"
		? HQ_CHANGES_STAGE_LABELS[stage](null)
		: HQ_CHANGES_STAGE_LABELS[stage];
}

/**
 * The `onEvent` an MCP tool hands a review or a bring-in of changes made in
 * CommCare HQ. A `stage` event sends one notification, tagged `hq_changes_`
 * and the stage, its message the stage's label as the panel shows it. A
 * `files` event sends one under the tag of the stage last named, with `done`
 * and `total` as `extra`, at most one a second, and always the one whose
 * `done` is `total`, as a bring-in of an app's sink sends its counts.
 *
 * `now` is the clock the interval is measured on, in milliseconds.
 */
export function hqChangesProgressSink(
	emitter: ProgressEmitter,
	now: () => number = () => performance.now(),
): (event: HqChangesProgressEvent) => void {
	let stage: HqChangesStage | null = null;
	let lastCountAt: number | null = null;
	return (event) => {
		if (event.type === "stage") {
			stage = event.stage;
			emitter.notify(
				HQ_CHANGES_PROGRESS_TAGS[event.stage],
				hqChangesStageLabel(event.stage),
			);
			return;
		}
		/* A count rides the stage that planned its files; one before any stage
		 * has no tag to go under. */
		if (stage === null) return;
		const at = now();
		const last = event.done === event.total;
		if (
			!last &&
			lastCountAt !== null &&
			at - lastCountAt < FILE_COUNT_INTERVAL_MS
		)
			return;
		lastCountAt = at;
		emitter.notify(
			HQ_CHANGES_PROGRESS_TAGS[stage],
			hqChangesStageLabel(stage),
			{
				done: event.done,
				total: event.total,
			},
		);
	};
}

/** What a review and a bring-in of changes made in CommCare HQ stream as they move. */
export type HqChangesProgressEvent =
	| { readonly type: "stage"; readonly stage: HqChangesStage }
	| { readonly type: "files"; readonly done: number; readonly total: number };

export interface ProgressEmitter {
	notify(
		stage: ProgressStage,
		message: string,
		extra?: Record<string, unknown>,
	): void;
}

/**
 * The request-scoped notification sender a progress emitter dispatches
 * through: the shape of the SDK's `ctx.mcpReq.notify`, narrowed to the
 * one notification this module sends. The SDK's own
 * `(notification: Notification) => Promise<void>` is assignable here
 * (its parameter is wider), so handlers pass `ctx.mcpReq.notify`
 * straight through without this module importing SDK types.
 */
export type ProgressNotifyFn = (notification: {
	method: "notifications/progress";
	params: {
		progressToken: string | number;
		progress: number;
		message: string;
	};
}) => Promise<void>;

/**
 * Format the notification message so both human and machine readers
 * can extract what they need from a single string. Prefix `[<stage>]`
 * lets clients branch on stage without needing structured metadata;
 * `| key=val` pairs append optional context inline.
 */
function formatProgressMessage(
	stage: ProgressStage,
	message: string,
	extra?: Record<string, unknown>,
): string {
	const prefix = `[${stage}]`;
	const extraParts = extra
		? Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`)
		: [];
	const suffix = extraParts.length > 0 ? ` | ${extraParts.join(" ")}` : "";
	return `${prefix} ${message}${suffix}`;
}

/**
 * Build a per-request progress emitter bound to the client's progress
 * token. Each `notify` call sends a `notifications/progress` message
 * through the request-scoped `notify` function, which associates the
 * notification with the request's response stream.
 *
 * The MCP spec requires `progress` to be a monotonically increasing
 * number so the client can order events and estimate throughput. The
 * counter is owned by this closure; callers express intent through the
 * stage + message arguments.
 *
 * When `progressToken` or `notify` is `undefined`, the returned emitter
 * is a no-op. That keeps adapter bodies branch-free.
 */
export function createProgressEmitter(
	notify: ProgressNotifyFn | undefined,
	progressToken: string | number | undefined,
): ProgressEmitter {
	/* Counter owned by this closure. `progress += 1` runs BEFORE each
	 * dispatch so the first `notify` sends `progress: 1` (MCP spec
	 * requires a monotonically-increasing number — compliant clients
	 * reject params missing it). */
	let progress = 0;
	return {
		notify(stage, message, extra) {
			if (progressToken === undefined || notify === undefined) return;
			progress += 1;
			/* Swallow delivery failure: a client that closed its stream
			 * mid-call must not turn a progress ping into an unhandled
			 * rejection inside the tool handler. */
			notify({
				method: "notifications/progress",
				params: {
					progressToken,
					progress,
					message: formatProgressMessage(stage, message, extra),
				},
			}).catch(() => {});
		},
	};
}
