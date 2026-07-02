/**
 * Shared `vi.mock("../firestore", ...)` factory fragment: pass-throughs for
 * the write-throttle wrappers, for suites that exercise transaction/write
 * BODIES (the ride-out itself is covered in writeThrottleRetry.test.ts).
 * Spread into a factory:
 *
 *   vi.mock("../firestore", async () => ({
 *     ...(await import("./throttlePassthrough")).throttlePassthrough,
 *     docs: { ... },
 *   }));
 *
 * One definition so a wrapper signature change updates every suite at once.
 */
export const throttlePassthrough = {
	runThrottledTransaction: (dbArg: unknown, fn: unknown) =>
		(
			dbArg as { runTransaction: (f: unknown) => Promise<unknown> }
		).runTransaction(fn),
	runThrottledWrite: (op: () => Promise<unknown>) => op(),
};
