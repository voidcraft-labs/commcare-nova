/** Per-process budgets. One parser runs per application process; four callers
 * may wait, and the deadline includes that wait. Linux RLIMIT_DATA also bounds
 * native Buffer allocations, which V8's heap limit does not cover. */
export const OFFICE_LIMITS = {
	inputBytes: 10 * 1024 * 1024,
	decodedBytes: 64 * 1024 * 1024,
	entries: 5_000,
	textBytes: 4 * 1024 * 1024,
	resultBytes: 34 * 1024 * 1024,
	heapMb: 256,
	dataKb: 768 * 1024,
	timeoutMs: 15_000,
	queued: 4,
} as const;
