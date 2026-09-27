/** Bounded retry policy for transient provider failures. The chat route reads
 * current durable private work through authoring/workMessages on each retry. */

import type { ClassifiedError, ErrorType } from "./errorClassifier";

/**
 * The failure buckets worth an automatic re-run: upstream/transport faults
 * that a fresh attempt can genuinely clear. `prompt_flagged` belongs here
 * because OpenAI's `invalid_prompt` verdict is not deterministic over an
 * unchanged request (it fires on ordinary content and clears on a re-send),
 * so the re-run costs one spaced attempt and spares the person a manual
 * retry. Everything else — auth, credits, a Nova-internal defect, a
 * deauthorized actor — fails the run as before (retrying those would loop on
 * a deterministic error).
 */
const TRANSIENT_TURN_ERRORS: ReadonlySet<ErrorType> = new Set([
	"api_server",
	"api_overloaded",
	"api_timeout",
	"api_rate_limit",
	"stream_broken",
	"prompt_flagged",
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

/** The user-visible signal while a retry is in flight: a RECOVERABLE
 *  conversation event (warning rendering, not a failure): the run has not
 *  failed, it is being re-driven. */
export const TURN_RETRY_MESSAGE =
	"A temporary provider error interrupted this run, so Nova is retrying automatically. Saved checkpoints and pending changes are preserved.";

/**
 * The retry notice for one classified fault. A flagged prompt is not a
 * provider outage, so telling the person "a temporary provider error"
 * three times and then "the request was flagged" misnames what happened;
 * the notice says what the provider did and that the re-run is automatic.
 * Every other transient bucket keeps the generic wording.
 */
export function turnRetryMessage(type: ErrorType): string {
	return type === "prompt_flagged"
		? "The model provider flagged this step as a possible usage-policy violation, which happens to ordinary content now and then, so Nova is trying the step again automatically. Saved checkpoints and pending changes are preserved."
		: TURN_RETRY_MESSAGE;
}
