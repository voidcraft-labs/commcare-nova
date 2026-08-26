/**
 * Nonblocking worker-compatible equivalent of JavaRosa's sleep function.
 * The evaluator must await this boundary and pass the already-evaluated second
 * argument, matching Core's observable return value without freezing Preview.
 */
export function javaRosaSleep<T>(
	milliseconds: number,
	value: T,
	signal?: AbortSignal,
): Promise<T> {
	if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
		return Promise.reject(
			new Error("Sleep duration must be a nonnegative integer."),
		);
	}
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve(value);
		}, milliseconds);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}
