/**
 * The two requests behind the changes made in CommCare HQ panel: a review,
 * which writes nothing, and a bring-in, which computes everything again and
 * acts only where its digest is the one sent. Plain `fetch` to Route
 * Handlers, never a Server Action: a tab's Server Actions run one at a time,
 * and a review that waits on CommCare HQ would hold every other action of
 * the tab behind it.
 *
 * Both routes answer a stream of NDJSON lines, read by the one stage stream
 * reader. A route that refuses before the stream answers JSON with a
 * status: the member's session ended (401), the member can no longer edit
 * the app (403, and 404, which a denial shares with a missing app), or a
 * body the route can't read (400, with the route's own sentence). Each is
 * said as what it is; anything else that is no stream is a request that
 * gave no answer.
 */

import type { LookupTableChoice, OwnerRuleChoice } from "@/lib/deployment";
import {
	HQ_CHANGES_STAGES,
	type HqChangesKey,
	type HqChangesOutcome,
	type HqChangesReview,
	type HqChangesStage,
} from "@/lib/deployment/hqChanges/types";
import {
	readStageStream,
	type StageStreamProgress,
} from "@/lib/deployment/reading/stream";
import {
	HQ_CHANGES_NO_EDIT_ACCESS_LINE,
	HQ_CHANGES_SIGNED_OUT_LINE,
} from "@/lib/publish/hqChangesCopy";

const REVIEW_PATH = "/api/commcare/changes/review";
const BRING_IN_PATH = "/api/commcare/changes/bring-in";

/** A stage or file line, as the panel takes it. */
export type HqChangesProgress = StageStreamProgress<HqChangesStage>;

/** How a request ended. */
export type HqChangesRequestEnd<T> =
	| { readonly kind: "done"; readonly answer: T }
	/** The stream's last line was `failed`: something on Nova's side, which it logged. */
	| { readonly kind: "failed" }
	/** No last line, no stream, or an answer of a kind the route does not give. */
	| { readonly kind: "lost" }
	/**
	 * The route refused before it read anything, with what to tell the
	 * person and whether checking again can help.
	 */
	| {
			readonly kind: "refused";
			readonly message: string;
			readonly checkAgain: boolean;
	  };

const REVIEW_KINDS: ReadonlySet<string> = new Set<HqChangesReview["kind"]>([
	"nothing",
	"changes",
	"account",
	"held",
	"unavailable",
	"stop",
]);

const OUTCOME_KINDS: ReadonlySet<string> = new Set<HqChangesOutcome["kind"]>([
	"brought-in",
	"recorded",
	"changed",
	"gate",
	"refused",
]);

function isStream(response: Response): boolean {
	return (
		response.headers.get("content-type")?.startsWith("application/x-ndjson") ??
		false
	);
}

async function post<T>(
	path: string,
	body: unknown,
	answerKinds: ReadonlySet<string>,
	onProgress: (event: HqChangesProgress) => void,
	signal: AbortSignal | undefined,
): Promise<HqChangesRequestEnd<T>> {
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
	if (!response.ok) return refusalOf(response);
	if (!isStream(response)) {
		await response.body?.cancel().catch(() => undefined);
		return { kind: "lost" };
	}
	const last = await readStageStream(response, HQ_CHANGES_STAGES, onProgress);
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

/**
 * What a route that answered no stream said. A 400 carries the route's own
 * sentence; a 401, 403 or 404 is the member's access; a status of Nova's
 * side is a failure Nova logged; anything else gave no answer.
 */
async function refusalOf<T>(
	response: Response,
): Promise<HqChangesRequestEnd<T>> {
	const { status } = response;
	if (status === 401) {
		await response.body?.cancel().catch(() => undefined);
		return {
			kind: "refused",
			message: HQ_CHANGES_SIGNED_OUT_LINE,
			checkAgain: true,
		};
	}
	if (status === 403 || status === 404) {
		await response.body?.cancel().catch(() => undefined);
		return {
			kind: "refused",
			message: HQ_CHANGES_NO_EDIT_ACCESS_LINE,
			checkAgain: false,
		};
	}
	if (status === 400) {
		const body: unknown = await response.json().catch(() => null);
		const error =
			typeof body === "object" && body !== null
				? (body as { readonly error?: unknown }).error
				: undefined;
		return typeof error === "string" && error.trim() !== ""
			? { kind: "refused", message: error, checkAgain: false }
			: { kind: "failed" };
	}
	await response.body?.cancel().catch(() => undefined);
	return status >= 500 ? { kind: "failed" } : { kind: "lost" };
}

/** `POST /api/commcare/changes/review`. Aborted by its signal when the panel goes. */
export function postHqChangesReview(
	key: HqChangesKey,
	onProgress: (event: HqChangesProgress) => void,
	signal: AbortSignal,
): Promise<HqChangesRequestEnd<HqChangesReview>> {
	return post<HqChangesReview>(
		REVIEW_PATH,
		key,
		REVIEW_KINDS,
		onProgress,
		signal,
	);
}

/** What a bring-in sends: the review's key, its reading and digest, and each table's and owner
 *  rule's answer. */
export interface HqChangesBringInBody extends HqChangesKey {
	readonly readingId: string;
	readonly reviewDigest: string;
	readonly tableChoices: Readonly<Record<string, LookupTableChoice>>;
	readonly ownerRuleChoices: Readonly<Record<string, OwnerRuleChoice>>;
}

/** `POST /api/commcare/changes/bring-in`. It takes no signal: a bring-in is never stopped. */
export function postHqChangesBringIn(
	body: HqChangesBringInBody,
	onProgress: (event: HqChangesProgress) => void,
): Promise<HqChangesRequestEnd<HqChangesOutcome>> {
	return post<HqChangesOutcome>(
		BRING_IN_PATH,
		body,
		OUTCOME_KINDS,
		onProgress,
		undefined,
	);
}
