// lib/utils/delay.ts
//
// Promise-returning sleep, shared by the modules that need a bounded
// backoff. A one-shot `setTimeout` that self-clears when it fires, so an
// awaited `delay` never leaves a pending timer. Two near-identical copies
// elsewhere are intentionally left in place: `lib/log/replay.ts`'s `sleep`
// is a different, abort-aware signature, and `lib/commcare/client.ts`
// keeps a local one-liner rather than reach across packages.

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
