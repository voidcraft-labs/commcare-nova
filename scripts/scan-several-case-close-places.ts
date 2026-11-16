/** Read-only census of the saved apps whose several-case own close is held
 * without its condition group. The console gets app ids, counts, statuses and
 * finding codes only; the reviewed plan goes only to the requested private
 * file. */
import "./lib/loadEnv";
import { writeFile } from "node:fs/promises";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";
import {
	appIdsToScan,
	inspectSeveralCaseClosePlaces,
	type SeveralCaseClosePlaceRepair,
} from "./lib/severalCaseClosePlaces";

const options = new Command()
	.description(
		"Count, without writing, each saved app's forms whose menu selects several cases and whose own close under a condition is held at the place published before its condition group, and judge each app's repair with the commit gate. Prints app ids, form counts, statuses (planned, held, refused) and finding codes only. With --plan-out it writes the reviewed plan for scripts/migrate-several-case-close-places.ts, one entry per planned app: its sequence, document digest, repaired-document digest and form ids. Exits 0 when no app holds such a close, 1 when some app does, 2 when an app could not be read. Run it with npx tsx --conditions=react-server; --prod reads production read-only.",
	)
	.option("--app <id>", "scan this app alone")
	.option("--plan-out <path>", "private reviewed plan JSON file")
	.option("--prod", "read production as the operator IAM identity")
	.parse()
	.opts<{ app?: string; planOut?: string; prod?: boolean }>();
if (options.prod) targetProdDb();

runMain(async () => {
	try {
		const appIds = await appIdsToScan(options.app);
		if (options.app !== undefined && appIds.length === 0)
			throw new Error(`No app has the id ${options.app}.`);
		const plan: SeveralCaseClosePlaceRepair[] = [];
		const totals = new Map<string, number>();
		let forms = 0;
		let unreadable = 0;
		for (const appId of appIds) {
			try {
				const inspection = await inspectSeveralCaseClosePlaces(appId);
				if (inspection.status === "unchanged") continue;
				totals.set(inspection.status, (totals.get(inspection.status) ?? 0) + 1);
				forms += inspection.forms;
				if (inspection.status === "planned") {
					plan.push(inspection.repair);
					console.log(
						JSON.stringify({
							appId,
							status: inspection.status,
							forms: inspection.forms,
						}),
					);
				} else console.log(JSON.stringify(inspection));
			} catch {
				unreadable += 1;
				console.error(JSON.stringify({ appId, unreadable: true }));
			}
		}
		if (options.planOut !== undefined)
			await writeFile(options.planOut, JSON.stringify(plan, null, 2), {
				mode: 0o600,
			});
		const affected = [...totals.values()].reduce((sum, n) => sum + n, 0);
		console.log(
			JSON.stringify({
				scanned: appIds.length,
				affected,
				forms,
				...Object.fromEntries(totals),
				unreadable,
			}),
		);
		process.exitCode = unreadable > 0 ? 2 : affected > 0 ? 1 : 0;
	} finally {
		await closeCaseStoreDatabase();
	}
});
