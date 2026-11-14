/** Writes each several-case own close held without its condition group at the
 * place the emitter gives it today, from a reviewed plan. Dry-run by default. */
import "./lib/loadEnv";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import {
	migrateSeveralCaseClosePlaces,
	previewSeveralCaseClosePlaceRepair,
	severalCaseClosePlaceRepairSchema,
} from "./lib/severalCaseClosePlaces";

const options = new Command()
	.description(
		"Apply the reviewed plan that scripts/scan-several-case-close-places.ts --plan-out wrote: move each held own close of a several-case form under its condition group, one blueprint-migration change per app, through the commit gate. Each app must still hold the sequence and document digest the scan read, and its repair must still produce the reviewed digest; otherwise the run stops and asks for a new scan. Dry-run by default: it checks each entry and judges it with the gate, writing nothing. Prints app ids, counts, statuses and finding codes only; an app the gate refuses is reported and left unchanged, and a rerun verifies the change it already wrote. Production execution uses the migration Job identity: in the maintenance image it is several-case-close-repair.cjs, run through the historical-repair Job with --plan-base64 and, for the reviewed write, --execute. Run the read-only scan again afterward and expect zero.",
	)
	.option("--plan <path>", "reviewed JSON plan file")
	.option("--plan-base64 <value>", "reviewed JSON plan for the maintenance Job")
	.option("--execute", "write the changes")
	.parse()
	.opts<{ plan?: string; planBase64?: string; execute?: boolean }>();
if ((options.plan === undefined) === (options.planBase64 === undefined))
	throw new Error("Provide exactly one of --plan or --plan-base64.");

runMain(async () => {
	try {
		const entries = z
			.array(severalCaseClosePlaceRepairSchema)
			.parse(
				JSON.parse(
					options.plan !== undefined
						? await readFile(options.plan, "utf8")
						: Buffer.from(options.planBase64 ?? "", "base64").toString("utf8"),
				),
			);
		if (new Set(entries.map((entry) => entry.appId)).size !== entries.length)
			throw new Error(
				"The repair plan names an app twice. Scan again and review a plan with one entry per app.",
			);
		const totals = new Map<string, number>();
		for (const entry of entries) {
			const outcome = options.execute
				? await migrateSeveralCaseClosePlaces(entry)
				: await previewSeveralCaseClosePlaceRepair(entry);
			totals.set(outcome.status, (totals.get(outcome.status) ?? 0) + 1);
			console.log(JSON.stringify(outcome));
		}
		console.log(
			JSON.stringify({
				execute: options.execute === true,
				planned: entries.length,
				...Object.fromEntries(totals),
			}),
		);
		if ((totals.get("refused") ?? 0) > 0) process.exitCode = 1;
	} finally {
		await closeCaseStoreDatabase();
	}
});
