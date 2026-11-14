/**
 * The deadline one list read owns across its pages: its signal and the
 * `Date.now()` instant it falls at, the pair `withHqRequestDeadline` hands
 * `run`. Always passed together, so a wait inside a page can tell beforehand
 * whether it would outlast the deadline.
 */
export interface HqReadDeadline {
	readonly signal: AbortSignal;
	readonly deadline: number;
}

/** The reason a deadline's signal carries when the deadline itself, and not a caller's `cancel`, ended it. */
class HqDeadlineReached extends DOMException {
	constructor() {
		super("The CommCare HQ request's deadline was reached", "TimeoutError");
	}
}

/**
 * Whether `signal` was aborted by a deadline `withHqRequestDeadline` owns,
 * rather than by the `cancel` a caller joined to it.
 */
export function hqDeadlineReached(signal: AbortSignal): boolean {
	return signal.aborted && signal.reason instanceof HqDeadlineReached;
}

/**
 * `run` gets a signal that aborts at the deadline, or sooner where `cancel`
 * aborts, and the deadline as an instant. The owner awaits the complete
 * operation, including response bytes, before its timer is released. A
 * deadline belongs to one call: a list read hands the pair to every page,
 * and no other caller lends its deadline to another read.
 */
export async function withHqRequestDeadline<T>(
	run: (signal: AbortSignal, deadline: number) => Promise<T>,
	milliseconds = 30_000,
	cancel?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	const deadline = Date.now() + milliseconds;
	const timer = setTimeout(
		() => controller.abort(new HqDeadlineReached()),
		milliseconds,
	);
	const signal =
		cancel === undefined
			? controller.signal
			: AbortSignal.any([controller.signal, cancel]);
	try {
		return await run(signal, deadline);
	} finally {
		clearTimeout(timer);
	}
}
