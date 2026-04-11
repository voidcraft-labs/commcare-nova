/**
 * Read-only inspection of a user's usage data.
 *
 * Shows monthly token consumption and cost estimates.
 * Never writes to Firestore.
 *
 * Usage:
 *   npx tsx scripts/inspect-usage.ts <userId>
 *   npx tsx scripts/inspect-usage.ts <userId> --all    # show all months, not just current
 */
import { db } from "./lib/firestore";
import { printHeader, printSection, tok, tsToISO, usd } from "./lib/format";

const userId = process.argv[2];
const showAll = process.argv.includes("--all");

if (!userId) {
	console.error("Usage: npx tsx scripts/inspect-usage.ts <userId> [--all]");
	process.exit(1);
}

async function main() {
	const monthsRef = db.collection("usage").doc(userId).collection("months");

	const snap = showAll
		? await monthsRef.orderBy("updated_at", "desc").get()
		: await monthsRef
				.where(
					"__name__",
					"==",
					new Date().toISOString().slice(0, 7), // yyyy-mm
				)
				.get();

	printHeader("USAGE INSPECTION (read-only)");

	console.log(`  User ID: ${userId}\n`);

	if (snap.empty) {
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

	for (const doc of snap.docs) {
		const d = doc.data();
		console.log(`  Period:    ${doc.id}`);
		console.log(`  Requests:  ${d.request_count ?? 0}`);
		console.log(`  Input:     ${tok(d.input_tokens ?? 0)} tokens`);
		console.log(`  Output:    ${tok(d.output_tokens ?? 0)} tokens`);
		console.log(`  Cost:      ${usd(d.cost_estimate ?? 0)}`);
		console.log(`  Updated:   ${tsToISO(d.updated_at)}`);
		console.log();
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
