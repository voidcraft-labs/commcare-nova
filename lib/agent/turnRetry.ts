/**
 * Turn-level auto-retry — the chat route's policy for re-running the SA turn
 * after a TRANSIENT mid-stream failure (a provider 500 halfway through a
 * generation, a dropped provider connection), inside the same POST / claim /
 * stream, invisibly to the user.
 *
 * Why this is safe — the property the whole feature leans on: an in-route
 * retry is the SAME operation as the manual retry users perform today, with
 * the same guarantees, because
 *
 *   1. every tool mutation was committed inline through the guarded writer
 *      BEFORE the failure, so no committed work is lost or replayed — the
 *      retry continues from the exact committed doc; and
 *   2. the validity gate rejects duplicate structural work at commit (a
 *      re-declared case type, a colliding field id), and a gate rejection is
 *      a normal tool-error the SA self-corrects from — so a retry that
 *      re-attempts something already done converges instead of duplicating.
 *
 * There is deliberately NO step-boundary retry here: an LLM step is
 * nondeterministic, so "resume the failed step" has no exactly-once meaning.
 * The turn is Nova's safe retry unit.
 *
 * The retry prompt appends one continuation message carrying the CURRENT
 * committed blueprint summary, so the model continues the request from the
 * committed state instead of re-planning work that already landed. Appending
 * (rather than rebuilding the system prompt) keeps the provider's cached
 * prefix intact across attempts.
 */

import type { ModelMessage } from "ai";
import type { BlueprintDoc } from "@/lib/domain";
import type { ClassifiedError, ErrorType } from "./errorClassifier";
import { summarizeBlueprint } from "./summarizeBlueprint";

/**
 * The failure buckets worth an automatic re-run: upstream/transport faults
 * that a fresh attempt can genuinely clear. Everything else — auth, credits,
 * a Nova-internal defect, a deauthorized actor — fails the run as before
 * (retrying those would loop on a deterministic error).
 */
const TRANSIENT_TURN_ERRORS: ReadonlySet<ErrorType> = new Set([
	"api_server",
	"api_overloaded",
	"api_timeout",
	"api_rate_limit",
	"stream_broken",
]);

/** Retries per turn (attempts = this + 1). Two is deliberate: it covers a
 *  blip and a short outage; a provider still down after three spaced attempts
 *  is a real outage the user should see. */
export const MAX_TURN_RETRIES = 2;

/** Spacing before each retry (index = retry number − 1). The POST is held
 *  open regardless (the run owns its claim + lease heartbeat), so waiting is
 *  free; the second gap is longer to ride out a rolling provider hiccup. */
const TURN_RETRY_DELAYS_MS = [2_000, 8_000] as const;

export function turnRetryDelayMs(retryNumber: number): number {
	return (
		TURN_RETRY_DELAYS_MS[
			Math.min(retryNumber, TURN_RETRY_DELAYS_MS.length) - 1
		] ?? 0
	);
}

/** Whether this classified failure, after `retriesSoFar` re-runs, gets
 *  another attempt. */
export function shouldRetryTurn(
	classified: ClassifiedError,
	retriesSoFar: number,
): boolean {
	return (
		TRANSIENT_TURN_ERRORS.has(classified.type) &&
		retriesSoFar < MAX_TURN_RETRIES
	);
}

/** The user-visible signal while a retry is in flight — a RECOVERABLE
 *  conversation event (warning rendering, not a failure): the run has not
 *  failed, it is being re-driven. */
export const TURN_RETRY_MESSAGE =
	"A temporary provider error interrupted this run — retrying automatically. Anything already built is saved and will not be redone.";

/**
 * The continuation message appended to the retry attempt's prompt: the
 * committed state (rendered by the same summarizer the edit prompt uses) plus
 * the instruction to continue rather than restart. Returns null for an empty
 * doc — with nothing committed, a bare re-run of the original messages IS the
 * continuation, and the extra message would only churn the cached prefix.
 *
 * Built fresh per retry from the LATEST committed doc and appended to the
 * BASE prompt (never stacked on a previous retry's note), so the model always
 * sees exactly one authoritative state snapshot.
 */
export function buildTurnRetryContinuation(
	doc: BlueprintDoc,
): ModelMessage | null {
	const hasContent =
		doc.moduleOrder.length > 0 ||
		(doc.caseTypes != null && Object.keys(doc.caseTypes).length > 0);
	if (!hasContent) return null;
	return {
		role: "user",
		content:
			"A temporary provider error interrupted your previous attempt at this request partway through. " +
			"Everything in the summary below is already committed to the app — do not re-create, re-declare, or re-add any of it. " +
			"Continue from this state and complete only the remaining work for the original request above.\n\n" +
			`Current app state:\n${summarizeBlueprint(doc)}`,
	};
}
