/**
 * A level-triggered, single-flight read pump for long-lived streams.
 *
 * Notifications are only pokes: `run` must read the durable source of truth.
 * Pokes that arrive while a read is in flight collapse into one immediate
 * follow-up read. A failed read reports the fault and retries for as long as the
 * pump is live, using capped exponential backoff. A fresh poke preempts that
 * backoff because it is useful evidence that the durable source may have moved.
 */

export type StreamPumpRetryScheduler = (
	callback: () => void,
	delayMs: number,
) => () => void;

export interface CoalescedStreamPumpOptions {
	/** One complete catch-up read from the caller-owned durable cursor. */
	readonly run: () => Promise<void>;
	/** Best-effort fault reporting; a reporter throw never stops the pump. */
	readonly onError: (error: unknown) => void;
	/** Delay before the first retry after a failed read. Defaults to 250 ms. */
	readonly retryMinMs?: number;
	/** Upper bound for retry delay. Defaults to 5 seconds. */
	readonly retryMaxMs?: number;
	/** Deterministic test seam. Production timers are unref'ed when supported. */
	readonly scheduler?: StreamPumpRetryScheduler;
}

export interface CoalescedStreamPump {
	/** Request catch-up. Safe to call repeatedly or after `close()`. */
	poke(): void;
	/** Permanently stop this pump and clear any pending retry. Idempotent. */
	close(): void;
}

const DEFAULT_INITIAL_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
function defaultScheduleRetry(
	callback: () => void,
	delayMs: number,
): () => void {
	const timer = setTimeout(callback, delayMs);
	// A disconnected client must never leave a retry keeping the process or a
	// test worker alive. Browsers return a number, hence the optional capability.
	timer.unref?.();
	return () => clearTimeout(timer);
}

function requirePositiveFinite(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number`);
	}
}

/**
 * Create a reusable coalesced read pump. Creation is inert; call `poke()` only
 * after the caller has subscribed to its notification source.
 */
export function createCoalescedStreamPump(
	options: CoalescedStreamPumpOptions,
): CoalescedStreamPump {
	const retryMinMs = options.retryMinMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
	const retryMaxMs = options.retryMaxMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

	requirePositiveFinite("retryMinMs", retryMinMs);
	requirePositiveFinite("retryMaxMs", retryMaxMs);
	if (retryMaxMs < retryMinMs) {
		throw new RangeError(
			"retryMaxMs must be greater than or equal to retryMinMs",
		);
	}

	const scheduleRetry = options.scheduler ?? defaultScheduleRetry;
	let closed = false;
	let inFlight = false;
	let pending = false;
	let cancelRetry: (() => void) | null = null;
	let nextRetryDelayMs = retryMinMs;

	function clearRetry(): void {
		const cancel = cancelRetry;
		cancelRetry = null;
		cancel?.();
	}

	function report(error: unknown): void {
		try {
			options.onError(error);
		} catch {
			// Observability must not become a second failure mode for the stream.
		}
	}

	function scheduleFailedReadRetry(): void {
		if (closed || cancelRetry !== null) return;
		const delayMs = nextRetryDelayMs;
		nextRetryDelayMs = Math.min(retryMaxMs, nextRetryDelayMs * 2);
		cancelRetry = scheduleRetry(() => {
			cancelRetry = null;
			if (closed) return;
			startRun();
		}, delayMs);
	}

	async function executeRun(): Promise<void> {
		let succeeded = false;
		try {
			await options.run();
			succeeded = true;
		} catch (error) {
			if (!closed) {
				report(error);
				scheduleFailedReadRetry();
			}
		} finally {
			inFlight = false;
			if (!closed) {
				if (succeeded) nextRetryDelayMs = retryMinMs;

				if (pending) {
					// A poke received during this run owns the immediate follow-up. If the
					// run failed, that fresh poke preempts the retry we just scheduled.
					pending = false;
					clearRetry();
					startRun();
				}
			}
		}
	}

	function startRun(): void {
		if (closed || inFlight) return;
		inFlight = true;
		void executeRun();
	}

	return {
		poke() {
			if (closed) return;
			if (inFlight) {
				pending = true;
				return;
			}
			// A real notification is more current than a pending backoff. Preserve
			// the failure streak; only a successful read resets its delay.
			clearRetry();
			startRun();
		},
		close() {
			if (closed) return;
			closed = true;
			pending = false;
			clearRetry();
		},
	};
}
