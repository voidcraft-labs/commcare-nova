/**
 * The bring-in page's three requests: the picker's list of a project space's
 * apps, a read of one app, and a create. Plain `fetch`, no Next router and no
 * Server Action, so a read that takes minutes holds nothing else of the tab
 * behind it and its stream can be read as it arrives.
 *
 * A route's refusal before its stream is ordinary JSON with a `code`. A 401
 * is the session that ended, which only a sign-in mends, so it is told apart
 * from every other failure: sending the request again answers the same. Every
 * other failure, a lost connection among them, carries nothing, since the
 * page answers them all the same way.
 */

import type {
	BringInInput,
	CreateAnswer,
	HqAppPicker,
	ReadingAnswer,
	ReadingEvent,
	ReadingKey,
	ReadingRefusal,
} from "@/lib/deployment";
import { readBringInStream } from "@/lib/deployment/reading/stream";
import { READING_REFUSALS } from "@/lib/deployment/reading/types";

export type BringInAnswer<T> =
	| { readonly ok: true; readonly value: T }
	/** A body with a `code` is that refusal. Any other failure, a lost request among them, is null. */
	| { readonly ok: false; readonly refusal: ReadingRefusal | null }
	/** The route answered 401: the person is no longer signed in. */
	| { readonly ok: false; readonly signedOut: true };

/** How a request to one of the two bring-in routes ended. */
export type BringInStreamEnd<T> =
	/** The stream's last line was `done`. */
	| { readonly kind: "done"; readonly answer: T }
	/** The stream's last line was `failed`. */
	| { readonly kind: "failed" }
	/** The route answered a JSON body with a `code` and opened no stream. */
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal }
	/** The route answered 401: the person is no longer signed in, and nothing was read or created. */
	| { readonly kind: "signed-out" }
	/** The stream ended with no last line, or the response was no stream, held no `code` and was no 401. */
	| { readonly kind: "lost" };

const HQ_APPS_PATH = "/api/commcare/hq-apps";
const READ_PATH = "/api/commcare/bring-in/read";
const CREATE_PATH = "/api/commcare/bring-in/create";

const REFUSALS: ReadonlySet<string> = new Set<string>(READING_REFUSALS);
const PICKER_KINDS: ReadonlySet<string> = new Set<HqAppPicker["kind"]>([
	"apps",
	"not-connected",
	"stop",
]);
const READING_ANSWER_KINDS: ReadonlySet<string> = new Set<
	ReadingAnswer["kind"]
>(["stop", "account", "review"]);
const CREATE_ANSWER_KINDS: ReadonlySet<string> = new Set<CreateAnswer["kind"]>([
	"created",
	"changed",
	"read-again",
	"check-failed",
	"held",
	"refused",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON a response holds, or undefined where its body is no JSON or could not be read. */
async function jsonOf(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

/** What every route answers a request whose session has ended (`requireSession`). */
const SIGNED_OUT_STATUS = 401;

/** The refusal a JSON body names in its `code`, or null where it names none. */
function refusalOf(body: unknown): ReadingRefusal | null {
	if (!isRecord(body) || typeof body.code !== "string") return null;
	return REFUSALS.has(body.code) ? (body.code as ReadingRefusal) : null;
}

/** `GET /api/commcare/hq-apps`. */
export async function fetchHqApps(
	input: { readonly domain: string },
	signal: AbortSignal,
): Promise<BringInAnswer<HqAppPicker>> {
	let response: Response;
	try {
		response = await fetch(
			`${HQ_APPS_PATH}?${new URLSearchParams({ domain: input.domain })}`,
			{ method: "GET", cache: "no-store", signal },
		);
	} catch {
		return { ok: false, refusal: null };
	}
	if (response.status === SIGNED_OUT_STATUS)
		return { ok: false, signedOut: true };
	const body = await jsonOf(response);
	if (!response.ok) return { ok: false, refusal: refusalOf(body) };
	if (
		!isRecord(body) ||
		!isRecord(body.picker) ||
		typeof body.picker.kind !== "string" ||
		!PICKER_KINDS.has(body.picker.kind)
	) {
		return { ok: false, refusal: null };
	}
	return { ok: true, value: body.picker as unknown as HqAppPicker };
}

function isStream(response: Response): boolean {
	return (
		response.headers.get("content-type")?.startsWith("application/x-ndjson") ??
		false
	);
}

/**
 * Posts `body` to one of the two bring-in routes and reads what it answers:
 * its stream to the last line, or the refusal it gave before opening one.
 * `answerKinds` are the kinds of answer that route's last line carries; any
 * other answer is no answer of that route, so the request is lost.
 */
async function postBringIn<T>(
	path: string,
	body: ReadingKey | BringInInput,
	answerKinds: ReadonlySet<string>,
	onEvent: (event: ReadingEvent) => void,
	signal: AbortSignal | undefined,
): Promise<BringInStreamEnd<T>> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			cache: "no-store",
			signal,
		});
	} catch {
		return { kind: "lost" };
	}
	if (response.status === SIGNED_OUT_STATUS) return { kind: "signed-out" };
	if (!response.ok || !isStream(response)) {
		const refusal = refusalOf(await jsonOf(response));
		return refusal === null ? { kind: "lost" } : { kind: "refused", refusal };
	}
	const last = await readBringInStream(response, onEvent);
	switch (last.type) {
		case "done":
			return answerKinds.has(last.answer.kind)
				? { kind: "done", answer: last.answer as T }
				: { kind: "lost" };
		case "failed":
			return { kind: "failed" };
		case "lost":
			return { kind: "lost" };
	}
}

/** `POST /api/commcare/bring-in/read`. `onEvent` takes each `stage` and `files` line as it arrives. */
export function postRead(
	key: ReadingKey,
	onEvent: (event: ReadingEvent) => void,
	signal: AbortSignal,
): Promise<BringInStreamEnd<ReadingAnswer>> {
	return postBringIn<ReadingAnswer>(
		READ_PATH,
		key,
		READING_ANSWER_KINDS,
		onEvent,
		signal,
	);
}

/** `POST /api/commcare/bring-in/create`. It takes no signal: a create is never stopped. */
export function postCreate(
	input: BringInInput,
	onEvent: (event: ReadingEvent) => void,
): Promise<BringInStreamEnd<CreateAnswer>> {
	return postBringIn<CreateAnswer>(
		CREATE_PATH,
		input,
		CREATE_ANSWER_KINDS,
		onEvent,
		undefined,
	);
}
