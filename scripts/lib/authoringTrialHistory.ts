import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { type PilotLedger, pilotCallCharge } from "./authoringPilotLedger";

/** Resume metadata identifies calls, not a historical global dollar balance. */
export async function priorTrialRuns(
	directory: string,
	appId: string,
	designSessionId: string,
): Promise<string[]> {
	const directories = new Set<string>();
	const runIds = new Set<string>();
	let current: string | undefined = directory;
	while (current) {
		const path = resolve(current);
		if (directories.has(path))
			throw new Error("Trial resume history contains a cycle.");
		directories.add(path);
		const run = z
			.object({
				runId: z.string(),
				appId: z.literal(appId),
				designSessionId: z.literal(designSessionId),
				resumedFrom: z.string().optional(),
			})
			.parse(JSON.parse(await readFile(resolve(path, "run.json"), "utf8")));
		runIds.add(run.runId);
		current = run.resumedFrom;
	}
	return [...runIds];
}

export function remainingTrialBudget(
	ledger: PilotLedger,
	runIds: readonly string[],
	trialCeilingUsd: number,
): number {
	const ids = new Set(runIds);
	const trialSpent = ledger.calls
		.filter((call) => ids.has(String(call.runId)))
		.reduce((total, call) => total + pilotCallCharge(call), 0);
	return Math.min(
		ledger.ceilingUsd - ledger.estimatedSpentUsd,
		ledger.targetUsd - ledger.estimatedSpentUsd,
		trialCeilingUsd - trialSpent,
	);
}
