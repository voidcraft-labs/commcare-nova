/** The owner awaits the complete operation, including response bytes, before its
 * timer is released. A paginated read passes this same signal to every page.
 * `run` also gets the deadline as a `Date.now()` instant, so a wait inside it
 * can tell beforehand whether it would outlast the deadline. */
export async function withHqRequestDeadline<T>(
	run: (signal: AbortSignal, deadline: number) => Promise<T>,
	milliseconds = 30_000,
): Promise<T> {
	const controller = new AbortController();
	const deadline = Date.now() + milliseconds;
	const timer = setTimeout(() => controller.abort(), milliseconds);
	try {
		return await run(controller.signal, deadline);
	} finally {
		clearTimeout(timer);
	}
}
