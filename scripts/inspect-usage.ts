/**
 * Read-only inspection of a user's usage data.
 *
 * Shows monthly token consumption and cost estimates. Reads the app-state
 * database the env provides (`NOVA_DB_LOCAL_URL` locally, the Cloud SQL
 * connector in the migrate-job image); `--prod` targets the production
 * instance over its public IP (see `./lib/prodDb.ts`). Never writes. Run
 * with `--help` for flags.
 */

import "dotenv/config";
import { Command } from "commander";
import type { Kysely } from "kysely";
import { getAuthDb } from "@/lib/auth/db";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { listAppsByOwner } from "@/lib/db/apps";
import { getCurrentPeriod } from "@/lib/db/period";
import type { AppDatabase } from "@/lib/db/pg";
import { getAppDb } from "@/lib/db/pg";
import { printHeader, printSection, tok, tsToISO, usd } from "./lib/format";
import { requireArg, runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface InspectUsageOptions {
	all?: boolean;
	prod?: boolean;
}

const program = new Command();
program
	.name("inspect-usage")
	.description(
		"Read-only inspection of a user's monthly token usage + cost. Also lists their recent apps.",
	)
	.argument("<userId>", "Better Auth user id (auth_user.id)")
	.option("--all", "show every month on record (default: current month only)")
	.option(
		"--prod",
		"inspect the production Cloud SQL instance (public IP + your gcloud IAM identity)",
	)
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/inspect-usage.ts <userId>\n" +
			"  $ npx tsx scripts/inspect-usage.ts <userId> --all\n" +
			"  $ npx tsx scripts/inspect-usage.ts <userId> --prod\n",
	);

program.parse();

const userId = requireArg(program.args, 0, "userId");
const usageOpts = program.opts<InspectUsageOptions>();
if (usageOpts.prod === true) {
	targetProdDb();
}
const showAll = usageOpts.all === true;

/** One month's usage row, normalized for display (bigint token columns read
 *  back as strings, so they're coerced to numbers here). */
interface UsageMonth {
	period: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	costEstimate: number;
	updatedAt: Date;
}

/**
 * Load the usage rows to render. In `--all` mode this is every month on
 * record, newest-first. Otherwise it's the single current-month row. An
 * absent row is a normal "no records" state, not an error.
 */
async function loadUsageRows(db: Kysely<AppDatabase>): Promise<UsageMonth[]> {
	let query = db
		.selectFrom("usage_months")
		.select([
			"period",
			"request_count",
			"input_tokens",
			"output_tokens",
			"cost_estimate",
			"updated_at",
		])
		.where("user_id", "=", userId);
	query = showAll
		? query.orderBy("updated_at", "desc")
		: query.where("period", "=", getCurrentPeriod());
	const rows = await query.execute();
	return rows.map((r) => ({
		period: r.period,
		requestCount: r.request_count,
		inputTokens: Number(r.input_tokens),
		outputTokens: Number(r.output_tokens),
		costEstimate: r.cost_estimate,
		updatedAt: r.updated_at,
	}));
}

async function main() {
	const db = await getAppDb();
	const rows = await loadUsageRows(db);

	printHeader("USAGE INSPECTION (read-only)");

	console.log(`  User ID: ${userId}\n`);

	if (rows.length === 0) {
		console.log("  No usage records found.");
		return;
	}

	/* Also fetch the user record for context — auth identity lives in the
	 * `auth_user` table on the same pool. Best-effort: a missing row just
	 * drops the context block, never fails the usage report. */
	try {
		const authDb = await getAuthDb();
		const u = await authDb
			.selectFrom("auth_user")
			.select(["name", "email", "role"])
			.where("id", "=", userId)
			.executeTakeFirst();
		if (u) {
			console.log(`  Name:    ${u.name ?? "(none)"}`);
			console.log(`  Email:   ${u.email ?? "(none)"}`);
			console.log(`  Role:    ${u.role ?? "user"}`);
			console.log();
		}
	} catch (err) {
		console.log(
			`  (user record unavailable: ${err instanceof Error ? err.message : String(err)})\n`,
		);
	}

	/* List their apps for reference. `AppSummary.updated_at` is already an
	 * ISO string, so it prints directly. */
	const { apps } = await listAppsByOwner(userId, {
		limit: 20,
		sort: "updated_desc",
	});

	if (apps.length > 0) {
		printSection("Apps");
		for (const a of apps) {
			const status =
				a.status === "error" ? `error (${a.error_type})` : a.status;
			console.log(
				`  ${a.id.slice(0, 8)}…  ${a.app_name.padEnd(30)} ${status.padEnd(20)} ${a.updated_at}`,
			);
		}
		console.log();
	}

	printSection("Monthly Usage");

	for (const row of rows) {
		console.log(`  Period:    ${row.period}`);
		console.log(`  Requests:  ${row.requestCount}`);
		console.log(`  Input:     ${tok(row.inputTokens)} tokens`);
		console.log(`  Output:    ${tok(row.outputTokens)} tokens`);
		console.log(`  Cost:      ${usd(row.costEstimate)}`);
		console.log(`  Updated:   ${tsToISO(row.updatedAt)}`);
		console.log();
	}
}

// Close the shared case-store pool so the process exits promptly — an open
// pool keeps the event loop alive.
runMain(async () => {
	try {
		await main();
	} finally {
		await closeCaseStoreDatabase();
	}
});
