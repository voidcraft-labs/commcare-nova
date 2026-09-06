/** The owner awaits the complete operation, including response bytes, before its
 * timer is released. A paginated read passes this same signal to every page. */
export async function withHqRequestDeadline<T>(
	run: (signal: AbortSignal) => Promise<T>,
	milliseconds = 30_000,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), milliseconds);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
