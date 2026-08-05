/**
 * WRITER: repair receipt-proven ordinary extension edges only. Dry-run by
 * default. Advanced-operation and otherwise ambiguous parent links are never
 * rewritten.
 */

import "dotenv/config";
import { Command } from "commander";
import { sql, type Transaction } from "kysely";
import {
	closeCaseStoreDatabase,
	type Database,
} from "../lib/case-store/postgres/connection";
import { getAppDb, withAppTx } from "../lib/db/pg";
import {
	classifyCaseParentRelationshipsInSnapshot,
	findCaseParentRelationshipFindings,
	repairCaseParentRelationships,
} from "./lib/caseParentRelationshipRepair";
import { loadPersistedBlueprintInTransaction } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";

interface Options {
	app?: string;
	execute?: boolean;
	confirmOldRevisionDrained?: boolean;
}

const program = new Command();
program
	.name("migrate-case-parent-relationships")
	.description(
		"Repair provably ordinary extension edges. Dry-run by default; ambiguous rows remain refusals.",
	)
	.option("--app <appId>", "scope the repair to one app")
	.option("--execute", "write compare-and-set repairs")
	.option(
		"--confirm-old-revision-drained",
		"confirm the new revision owns 100% traffic and old requests have drained",
	)
	.addHelpText(
		"after",
		"\nProduction writes run through the dedicated immutable Cloud Run Job. There is intentionally no --prod writer shortcut.\n",
	);
program.parse();
const options = program.opts<Options>();
const productionJob =
	process.env.NOVA_CASE_PARENT_RELATIONSHIP_PRODUCTION_JOB === "true";

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((caseId, index) => caseId === right[index])
	);
}

async function main(): Promise<void> {
	if (options.execute === true && options.confirmOldRevisionDrained !== true) {
		throw new Error(
			"--execute requires --confirm-old-revision-drained after the new revision owns 100% traffic.",
		);
	}
	const db = await getAppDb();
	let appsQuery = db.selectFrom("apps").select(["id", "app_name"]);
	if (options.app !== undefined) {
		appsQuery = appsQuery.where("id", "=", options.app);
	}
	const apps = await appsQuery.orderBy("id").execute();
	if (options.app !== undefined && apps.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	console.log(
		options.execute === true
			? "Repairing receipt-proven ordinary extension edges…\n"
			: "DRY RUN: nothing writes without --execute.\n",
	);
	let planned = 0;
	let repaired = 0;
	let ambiguous = 0;
	let failures = 0;
	for (const app of apps) {
		try {
			if (options.execute !== true) {
				const snapshot = await db
					.transaction()
					.setIsolationLevel("repeatable read")
					.setAccessMode("read only")
					.execute((tx) =>
						classifyCaseParentRelationshipsInSnapshot(tx, app.id),
					);
				if (snapshot === null) continue;
				const findings = snapshot.findings;
				const candidates = findings.filter(
					(finding) => finding.standing === "repairable-ordinary",
				);
				const unresolved = findings.filter(
					(finding) =>
						finding.standing !== "clean" &&
						finding.standing !== "repairable-ordinary",
				);
				planned += candidates.length;
				ambiguous += unresolved.length;
				if (candidates.length > 0 || unresolved.length > 0) {
					console.log(
						`${snapshot.appId} (${snapshot.appName || "unnamed"}), Project ${snapshot.projectId}: ${candidates.length} repairable; ${unresolved.length} refused as ambiguous/topology`,
					);
				}
				continue;
			}

			const result = await withAppTx(async (tx) => {
				const locked = await tx
					.selectFrom("apps")
					.select("project_id")
					.where("id", "=", app.id)
					.forUpdate()
					.executeTakeFirst();
				if (locked === undefined) return { repaired: 0, ambiguous: 0 };
				const scope = `nova:case-relationships:${locked.project_id}:${app.id}`;
				await sql`select pg_advisory_xact_lock(hashtextextended(${scope}, 0::bigint))`.execute(
					tx,
				);
				const blueprint = await loadPersistedBlueprintInTransaction(tx, app.id);
				if (blueprint === null) return { repaired: 0, ambiguous: 0 };
				const caseTx = tx as unknown as Transaction<Database>;
				const findings = await findCaseParentRelationshipFindings(caseTx, {
					appId: app.id,
					projectId: locked.project_id,
					blueprint,
				});
				const candidates = findings.filter(
					(finding) => finding.standing === "repairable-ordinary",
				);
				const unresolved = findings.filter(
					(finding) =>
						finding.standing !== "clean" &&
						finding.standing !== "repairable-ordinary",
				);
				const groups = new Map<
					string,
					{
						caseType: string;
						parentType: string;
						caseIds: string[];
					}
				>();
				for (const candidate of candidates) {
					const key = `${candidate.caseType}\0${candidate.parentType}`;
					const group = groups.get(key) ?? {
						caseType: candidate.caseType,
						parentType: candidate.parentType,
						caseIds: [],
					};
					group.caseIds.push(candidate.caseId);
					groups.set(key, group);
				}
				let repairedHere = 0;
				for (const group of groups.values()) {
					const expected = group.caseIds.toSorted();
					const updated = await repairCaseParentRelationships(caseTx, {
						appId: app.id,
						projectId: locked.project_id,
						caseType: group.caseType,
						parentType: group.parentType,
						caseIds: expected,
					});
					if (!sameIds(updated, expected)) {
						throw new Error(
							`compare-and-set mismatch for ${group.caseType}: expected ${expected.length}, updated ${updated.length}`,
						);
					}
					repairedHere += updated.length;
				}
				return { repaired: repairedHere, ambiguous: unresolved.length };
			});
			repaired += result.repaired;
			ambiguous += result.ambiguous;
			if (result.repaired > 0 || result.ambiguous > 0) {
				console.log(
					`${app.id} (${app.app_name || "unnamed"}): repaired ${result.repaired}; ${result.ambiguous} ambiguous/topology refusal(s) remain`,
				);
			}
		} catch (error) {
			failures++;
			console.log(
				`${app.id}: FAILED: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	console.log(
		options.execute === true
			? `\nRepaired ${repaired} row(s); ${ambiguous} ambiguous/topology refusal(s); ${failures} failed app(s).`
			: `\nWould repair ${planned} row(s); ${ambiguous} ambiguous/topology refusal(s); ${failures} failed app(s).`,
	);
	const scope = options.app === undefined ? "" : ` --app ${options.app}`;
	console.log(
		`Independent proof: npx tsx scripts/scan-case-parent-relationships.ts${productionJob ? " --prod" : ""}${scope}`,
	);
	if (ambiguous > 0 || failures > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
