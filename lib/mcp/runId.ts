/**
 * Server-side `run_id` derivation.
 *
 * The MCP wire surface does not carry `run_id` — clients never supply
 * one and never see one. The server infers a grouping id from state it
 * already observes (the app's `run_id` field + `updated_at` timestamp)
 * so admin surfaces can stitch related event-log rows together without
 * trusting or validating client-supplied ids.
 *
 * Sliding-window semantics: as long as mutations keep landing on an app
 * within `WINDOW_MS`, they all share the app's current `run_id`. After
 * `WINDOW_MS` of inactivity, the next mutation mints a fresh id and the
 * old run is "closed" in the event log.
 *
 * Pure function — the caller extracts primitives from the `AppDoc` and
 * passes them in, keeping the signature free of storage types so the
 * derivation is trivially unit-testable.
 */

/**
 * Window of inactivity after which a run is considered closed. 30 minutes
 * handles the realistic pauses during a multi-step build (tool-call
 * round-trips, user AskUserQuestion responses, model thinking) without
 * letting unrelated later work accidentally join.
 */
export const RUN_WINDOW_MS = 30 * 60 * 1000;

/**
 * Input shape for `deriveRunId`: the current `run_id` on the app doc
 * (null on brand-new apps that never ran), the epoch-ms of the app's
 * most recent mutation, and the current wall-clock. Wall-clock is
 * injectable so tests can pin time without freezing the whole runtime.
 */
export interface DeriveRunIdInput {
	/** Currently recorded run_id on the app doc, or null if never set. */
	currentRunId: string | null;
	/**
	 * Epoch-ms of the app's last write (i.e. `updated_at.getTime()`). Null
	 * when the app has never been written — shouldn't happen in practice
	 * (create_app always seeds both fields) but the null case is handled
	 * defensively so the derivation doesn't crash on a malformed row.
	 */
	lastActiveMs: number | null;
	/** Wall-clock at the moment the tool call is handled. */
	now: Date;
}

/**
 * Return the run_id the current tool call should ride under.
 *
 * - If the app has a `currentRunId` and `lastActiveMs` is within
 *   `RUN_WINDOW_MS` of `now`, reuse it. Subsequent writes in the same
 *   run share a grouping id across their event-log rows.
 * - Otherwise (no prior run, or window elapsed), mint a fresh UUID v4.
 *   The caller is responsible for persisting the new id back onto the
 *   app doc so the next call in this run reuses it.
 */
export function deriveRunId(input: DeriveRunIdInput): string {
	if (
		input.currentRunId &&
		input.lastActiveMs !== null &&
		input.now.getTime() - input.lastActiveMs < RUN_WINDOW_MS
	) {
		return input.currentRunId;
	}
	return crypto.randomUUID();
}
