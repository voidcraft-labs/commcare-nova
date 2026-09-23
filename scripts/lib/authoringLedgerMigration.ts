import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { MODEL_PRICING } from "@/lib/models";
import { reconcilePilotLedger, withPilotLedger } from "./authoringPilotLedger";

export async function scanTrialLedger(path: string, ceilingUsd: number) {
	const bytes = await readFile(path);
	const result = reconcilePilotLedger(JSON.parse(bytes.toString()), ceilingUsd);
	return {
		...result,
		sourceSha256: createHash("sha256").update(bytes).digest("hex"),
		pricing: MODEL_PRICING,
		unresolvedCalls: result.ledger.calls.filter(
			(call) => call.status !== "completed",
		).length,
	};
}

/** Preserve the source and refuse stale scans or an existing destination. */
export async function migrateTrialLedger(
	source: string,
	destination: string,
	ceilingUsd: number,
	expectedSha256: string,
) {
	return withPilotLedger(source, async (locked) => {
		const scan = await scanTrialLedger(locked.path, ceilingUsd);
		if (scan.sourceSha256 !== expectedSha256)
			throw new Error("The source ledger changed after its scan.");
		const output = await open(destination, "wx", 0o600);
		try {
			await output.writeFile(JSON.stringify(scan.ledger, null, 2));
			await output.sync();
		} finally {
			await output.close();
		}
		return scan;
	});
}
