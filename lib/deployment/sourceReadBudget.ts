import "server-only";

import { processMemoryMeter, runInLease } from "@/lib/commcare/hq/memoryMeter";
import { LookupError } from "@/lib/lookup/errors";

// Both paths decode bounded HQ pages and can hold a row across asynchronous
// storage work. They share one admission slot and the ordinary request meter.
let occupied = false;
export async function withSourceBulkRead<T>(
	read: (signal: AbortSignal) => Promise<T>,
) {
	if (occupied)
		throw new LookupError(
			"storage_limit",
			"A large table is being read. You can retry after the read finishes.",
		);
	const lease = processMemoryMeter().open();
	occupied = true;
	try {
		return await runInLease(lease, () => read(lease.signal));
	} finally {
		lease.end();
		occupied = false;
	}
}
