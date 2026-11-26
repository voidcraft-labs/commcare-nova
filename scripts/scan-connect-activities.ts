/**
 * READ-ONLY: size the Connect conversion over every stored app.
 *
 * The released document holds one app-wide Connect type (`apps.connect_type`)
 * and at most one block of each kind in each form (`form.connect`). The
 * current document holds a set of roles (`apps.connect_roles`) and each block
 * as a `connect_activity` field at its place in the form. A row whose
 * `connect_roles` is NULL still holds the released shape and cannot be opened
 * until the reviewed conversion (`scripts/migrations/step7-connect-activities.mjs`)
 * has written it.
 *
 * For every such row, including deleted ones a restore can still reach, this
 * reads the released projection the fold snapshot function returns, converts
 * it with that same converter, parses it with the current document schema,
 * and runs the commit gate over it against the Project's lookup definitions
 * as they stand. It reports identities, counts and finding codes only: no
 * names, ids, expressions or values leave the database.
 *
 * Needs the additive migration `20261208000000_connect_activity_roles` (the
 * `connect_roles` column and the converting fold snapshot). Reads the database
 * the env provides; `--prod` reads production over its public IP as your
 * gcloud IAM identity (`./lib/prodDb.ts`). Never writes.
 */
import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import {
	scanConnectActivities,
	summarizeConnectScan,
} from "./lib/connectActivityScan";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface ScanOptions {
	readonly app?: string;
	readonly output?: string;
	readonly prod?: boolean;
}

const options = new Command()
	.name("scan-connect-activities")
	.description(
		"Convert every app still holding the released Connect shape in memory and report whether the current document admits it (read-only).",
	)
	.option("--app <appId>", "scope the scan to a single app")
	.option(
		"--output <path>",
		"also write every app's outcome as JSON (new file)",
	)
	.option(
		"--prod",
		"scan the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.parse()
	.opts<ScanOptions>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const outcomes = await scanConnectActivities(await getAppDb(), options.app);
		console.log(JSON.stringify(summarizeConnectScan(outcomes), null, 2));
		if (options.output !== undefined)
			await writeFile(options.output, `${JSON.stringify(outcomes)}\n`, {
				flag: "wx",
				mode: 0o600,
			});
	} finally {
		await closeCaseStoreDatabase();
	}
});
