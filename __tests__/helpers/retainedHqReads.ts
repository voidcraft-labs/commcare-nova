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
