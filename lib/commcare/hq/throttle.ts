/**
 * How Nova waits out CommCare HQ's limiter.
 *
 * HQ counts API requests by project space (`api/resources/meta.py::HQThrottle`
 * over `api_rate_limiter`). A function view under
 * `api/decorators.py::api_throttle` answers 429 with `Retry-After` in decimal
 * seconds; a tastypie resource whose `Meta` extends `CustomResourceMeta`
 * answers 429 with none, because tastypie's `Resource.throttle_check` writes
 * the header only for an int or a datetime and `should_be_throttled` returns
 * a bool. HQ's minute, hour and day windows are the project space's whole
 * budget, and a wait cannot widen it, so only a short wait is waited.
 */

/** The most a read or an import waits on one 429 before sending again. */
export const HQ_THROTTLE_MAX_WAIT_MS = 2_000;
/** The wait for a 429 that names none: a tastypie resource's, or an edge's. */
export const HQ_THROTTLE_ABSENT_WAIT_MS = 1_000;
/** How many times one read is sent at most: the first and two resends. */
export const HQ_READ_SENDS = 3;
/** How many throttled reads of one bring-in are in flight at once. */
export const HQ_THROTTLED_READ_CONCURRENCY = 1;

/**
 * The wait before a read is sent again, or null when its 429 is the answer:
 * `HQ_THROTTLE_ABSENT_WAIT_MS` where the 429 named no wait, the wait it named
 * where that is at most `HQ_THROTTLE_MAX_WAIT_MS`.
 */
export function readRetryWaitMs(retryAfter: number | undefined): number | null {
	if (retryAfter === undefined) return HQ_THROTTLE_ABSENT_WAIT_MS;
	return retryAfter <= HQ_THROTTLE_MAX_WAIT_MS ? retryAfter : null;
}
