import { randomUUID } from "node:crypto";
import { open, realpath, rename, rm } from "node:fs/promises";
import { estimateCost } from "@/lib/db/usage";

/** A crashed owner leaves its lock and pending reservations for inspection. */
export async function withPilotLedger<T>(
	path: string,
	run: (file: {
		path: string;
		save: (value: unknown) => Promise<void>;
	}) => Promise<T>,
): Promise<T> {
	const resolved = await realpath(path);
	const lockPath = `${resolved}.lock`;
	const lock = await open(lockPath, "wx", 0o600);
	try {
		await lock.writeFile(String(process.pid));
		return await run({
			path: resolved,
			save: async (value) => {
				const temporary = `${resolved}.${randomUUID()}.tmp`;
				try {
					const file = await open(temporary, "wx", 0o600);
					try {
						await file.writeFile(JSON.stringify(value, null, 2));
						await file.sync();
					} finally {
						await file.close();
					}
					await rename(temporary, resolved);
				} finally {
					await rm(temporary, { force: true });
				}
			},
		});
	} finally {
		try {
			await lock.close();
		} finally {
			await rm(lockPath);
		}
	}
}

export function completedPilotCharge(
	model: string,
	usage: { inputTokens?: number; outputTokens?: number },
	reservedUsd: number,
) {
	const { inputTokens, outputTokens } = usage;
	if (
		typeof inputTokens !== "number" ||
		!Number.isFinite(inputTokens) ||
		inputTokens < 0 ||
		typeof outputTokens !== "number" ||
		!Number.isFinite(outputTokens) ||
		outputTokens < 0
	)
		return { status: "completed-unmetered", estimatedUsd: reservedUsd };
	// All input is priced uncached; the margin includes cache-write overhead.
	return {
		status: "completed",
		estimatedUsd: estimateCost(model, inputTokens, outputTokens) * 1.25,
	};
}
