/**
 * Read-only inspection of a user's usage data.
 *
 * Shows monthly token consumption and cost estimates.
 * Never writes to Firestore. Run with `--help` for flags.
 */
import { Command } from "commander";
import { db } from "./lib/firestore";
import { printHeader, printSection, tok, tsToISO, usd } from "./lib/format";
import { requireArg, runMain } from "./lib/main";

interface InspectUsageOptions {
	all?: boolean;
}

const program = new Command();
program
	.name("inspect-usage")
	.description(
		"Read-only inspection of a user's monthly token usage + cost. Also lists their recent apps.",
	)
	.argument("<userId>", "Better Auth user id (auth_users doc id)")
	.option("--all", "show every month on record (default: current month only)")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/inspect-usage.ts <userId>\n" +
			"  $ npx tsx scripts/inspect-usage.ts <userId> --all\n",
	);

program.parse();

const userId = requireArg(program.args, 0, "userId");
const showAll = program.opts<InspectUsageOptions>().all === true;

/** Shape of a single month's usage row as read from Firestore. */
interface UsageMonth {
	period: string;
	data: {
		request_count?: number;
		input_tokens?: number;
		output_tokens?: number;
		cost_estimate?: number;
		updated_at?: { toDate(): Date } | null;
	};
}

/**
 * Load the usage rows to render. In `--all` mode this is every month on
 * record, newest-first. Otherwise it's the single current-month doc
 * looked up by ID — `.doc(yyyyMm).get()` is the direct API, no predicate,
 * no index cost. An absent current-month doc is a normal "no records"
 * state, not an error.
 */
async function loadUsageRows(): Promise<UsageMonth[]> {
	const monthsRef = db.collection("usage").doc(userId).collection("months");

	if (showAll) {
		const snap = await monthsRef.orderBy("updated_at", "desc").get();
		return snap.docs.map((d) => ({
			period: d.id,
			data: d.data() as UsageMonth["data"],
		}));
	}

	const yyyyMm = new Date().toISOString().slice(0, 7);
	const doc = await monthsRef.doc(yyyyMm).get();
	if (!doc.exists) return [];
	// biome-ignore lint/style/noNonNullAssertion: guarded by doc.exists
	return [{ period: doc.id, data: doc.data()! as UsageMonth["data"] }];
}

async function main() {
	const rows = await loadUsageRows();

	printHeader("USAGE INSPECTION (read-only)");

	console.log(`  User ID: ${userId}\n`);

	if (rows.length === 0) {
		console.log("  No usage records found.");
		return;
	}

	/* Also fetch user record for context. */
	const userSnap = await db.collection("auth_users").doc(userId).get();
	if (userSnap.exists) {
		// biome-ignore lint/style/noNonNullAssertion: guarded by userSnap.exists check
		const u = userSnap.data()!;
		console.log(`  Name:    ${u.name ?? "(none)"}`);
		console.log(`  Email:   ${u.email ?? "(none)"}`);
		console.log(`  Role:    ${u.role ?? "user"}`);
		console.log();
	}

	/* List their apps for reference. */
	const appsSnap = await db
		.collection("apps")
		.where("owner", "==", userId)
		.select("app_name", "status", "error_type", "created_at", "updated_at")
		.orderBy("updated_at", "desc")
		.limit(20)
		.get();

	if (!appsSnap.empty) {
		printSection("Apps");
		for (const doc of appsSnap.docs) {
			const a = doc.data();
			const status =
				a.status === "error" ? `error (${a.error_type})` : a.status;
			console.log(
				`  ${doc.id.slice(0, 8)}…  ${(a.app_name || "(unnamed)").padEnd(30)} ${status.padEnd(20)} ${tsToISO(a.updated_at)}`,
			);
		}
		console.log();
	}

	printSection("Monthly Usage");

	for (const { period, data: d } of rows) {
		console.log(`  Period:    ${period}`);
		console.log(`  Requests:  ${d.request_count ?? 0}`);
		console.log(`  Input:     ${tok(d.input_tokens ?? 0)} tokens`);
		console.log(`  Output:    ${tok(d.output_tokens ?? 0)} tokens`);
		console.log(`  Cost:      ${usd(d.cost_estimate ?? 0)}`);
		console.log(`  Updated:   ${tsToISO(d.updated_at)}`);
		console.log();
	}
}

runMain(main);
