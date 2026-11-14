/**
 * CommCare HQ's own answers, as the proof lane retained them.
 *
 * `proof/hq/test_retained_reads.py` makes each state in the lane's HQ, reads
 * it through HQ's own views, and holds the committed files under
 * `proof/hq-reads/` to what HQ answers, byte for byte, at the pinned
 * commit. A Nova test that needs an answer of HQ's serves one of these
 * rather than writing its own, so a pin that changes an answer fails in the
 * lane and never leaves Nova's tests reading a stale one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { MockAgent } from "undici";

/** The publish group's answers (`proof/hq-reads/publish/`). */
export type RetainedPublishRead =
	| "source-live"
	| "source-shell"
	| "source-deleted"
	| "source-linked"
	| "source-missing"
	| "source-after-create-then-update"
	| "update-deleted"
	| "update-missing"
	| "update-linked"
	| "import-429-second"
	| "import-429-minute";

/** One retained answer: a status, the headers HQ sent, and its body. */
export interface RetainedHqAnswer {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	/** The body as HQ sent it: its text, or the JSON value it held; absent for none. */
	readonly body?: unknown;
}

const PUBLISH_READS = path.join(process.cwd(), "proof", "hq-reads", "publish");

export function retainedPublishRead(
	name: RetainedPublishRead,
): RetainedHqAnswer {
	const raw = JSON.parse(
		readFileSync(path.join(PUBLISH_READS, `${name}.json`), "utf8"),
	) as { status: number; headers?: Record<string, string>; body?: unknown };
	return { status: raw.status, headers: raw.headers ?? {}, body: raw.body };
}

/** The files of `proof/hq-reads/reading/`, by name without `.json`. */
export type RetainedReadingRead =
	| "list-apps"
	| "list-apps-429"
	| "api-access"
	| "api-access-no-plan"
	| "api-access-no-permission"
	| "application"
	| "application-error-module"
	| "application-no-api-access"
	| "application-no-api-access-superuser"
	| "application-api-cut-off"
	| "application-no-permission"
	| "application-linked"
	| "application-deleted"
	| "application-remote"
	| "application-other-space"
	| "application-build"
	| "application-429"
	| "source-remote"
	| "source-other-space"
	| "source-shadow"
	| "application-shadow"
	| "current-version"
	| "current-version-after-save"
	| "fixture-rows-empty-field"
	| "project-spaces"
	| "project-spaces-flag-on"
	| "project-spaces-flag-off";

const READING_READS = path.join(process.cwd(), "proof", "hq-reads", "reading");

/**
 * One reading answer. A file that holds `{"exception": "<class>"}` is a view
 * that raised, which a deployed HQ answers through its `handler500`: it is
 * read as `{ status: 500, headers: {} }` with no body, and no test serves an
 * exception's name.
 */
export function retainedReadingRead(
	name: RetainedReadingRead,
): RetainedHqAnswer {
	const raw = JSON.parse(
		readFileSync(path.join(READING_READS, `${name}.json`), "utf8"),
	) as {
		status?: number;
		headers?: Record<string, string>;
		body?: unknown;
		exception?: string;
	};
	if (raw.exception !== undefined) return { status: 500, headers: {} };
	if (raw.status === undefined)
		throw new Error(`The retained reading ${name} holds no status.`);
	return { status: raw.status, headers: raw.headers ?? {}, body: raw.body };
}

/**
 * The retained `application` answer with its body's `id` set to `appId` and its `versions` set
 * to `versions`, HQ's build rows as a suite writes them.
 */
export function applicationAnswer(
	appId: string,
	versions: readonly unknown[],
): RetainedHqAnswer {
	const answer = retainedReadingRead("application");
	return {
		...answer,
		body: JSON.stringify({
			...retainedBodyJson(answer),
			id: appId,
			versions,
		}),
	};
}

/**
 * Another group's retained read by its path under `proof/hq-reads/`, without
 * `.json` (`hq-built/app-source`), for a suite that reads one state of a
 * group no helper above names.
 */
export function retainedGroupRead(file: string): RetainedHqAnswer {
	const raw = JSON.parse(
		readFileSync(
			path.join(process.cwd(), "proof", "hq-reads", `${file}.json`),
			"utf8",
		),
	) as { status: number; headers?: Record<string, string>; body?: unknown };
	return { status: raw.status, headers: raw.headers ?? {}, body: raw.body };
}

/** The retained answer's body as the bytes a peer sends. */
export function retainedBodyText(answer: RetainedHqAnswer): string {
	if (answer.body === undefined || answer.body === null) return "";
	return typeof answer.body === "string"
		? answer.body
		: JSON.stringify(answer.body);
}

/** The retained answer's body as JSON, for a test that derives one key from it. */
export function retainedBodyJson(
	answer: RetainedHqAnswer,
): Record<string, unknown> {
	const value =
		typeof answer.body === "string" ? JSON.parse(answer.body) : answer.body;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("The retained answer holds no JSON object.");
	}
	return value as Record<string, unknown>;
}

/** Reply to one intercepted request with a retained answer, or one derived from it. */
export function replyRetained(
	interceptor: ReturnType<ReturnType<MockAgent["get"]>["intercept"]>,
	answer: RetainedHqAnswer,
): void {
	interceptor.reply(answer.status, retainedBodyText(answer), {
		headers: { ...answer.headers },
	});
}
