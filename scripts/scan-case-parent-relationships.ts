/** READ ONLY: classify historical extension parent edges before repair. */

import "dotenv/config";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "../lib/case-store/postgres/connection";
import { getAppDb } from "../lib/db/pg";
import {
	type CaseParentRelationshipStanding,
	classifyCaseParentRelationshipsInSnapshot,
} from "./lib/caseParentRelationshipRepair";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

interface Options {
	app?: string;
	prod?: boolean;
}

const program = new Command();
program
	.name("scan-case-parent-relationships")
	.description(
		"Classify extension parent edges without rewriting advanced-operation links (read-only).",
	)
	.option("--app <appId>", "scope the scan to one app")
	.option("--prod", "scan production through the read-only operator identity")
	.addHelpText(
		"after",
		"\nRun before the paired migration and independently afterward. Any non-clean standing exits nonzero.\n",
	);
program.parse();
const options = program.opts<Options>();
if (options.prod === true) targetProdDb();

const standings: readonly CaseParentRelationshipStanding[] = [
	"clean",
	"repairable-ordinary",
	"operation-touched",
	"catalog-changed",
	"unknown-origin",
	"noncanonical-topology",
];

function scopeArgs(): string {
	return options.app === undefined ? "" : ` --app ${options.app}`;
}

async function main(): Promise<void> {
	const db = await getAppDb();
	let appsQuery = db.selectFrom("apps").select("id");
	if (options.app !== undefined) {
		appsQuery = appsQuery.where("id", "=", options.app);
	}
	const apps = await appsQuery.orderBy("id").execute();
	if (options.app !== undefined && apps.length === 0) {
		throw new Error(`App ${options.app} not found.`);
	}

	let actionable = 0;
	let ambiguous = 0;
	let failures = 0;
	for (const app of apps) {
		try {
			const snapshot = await db
				.transaction()
				.setIsolationLevel("repeatable read")
				.setAccessMode("read only")
				.execute((tx) => classifyCaseParentRelationshipsInSnapshot(tx, app.id));
			if (snapshot === null) continue;
			const findings = snapshot.findings;
			if (findings.length === 0) continue;
			const counts = new Map<CaseParentRelationshipStanding, number>();
			for (const finding of findings) {
				counts.set(finding.standing, (counts.get(finding.standing) ?? 0) + 1);
				if (finding.standing === "repairable-ordinary") actionable++;
				else if (finding.standing !== "clean") ambiguous++;
			}
			console.log(
				`${snapshot.appId} (${snapshot.appName || "unnamed"}), Project ${snapshot.projectId}`,
			);
			console.log(
				`  ${standings.map((standing) => `${standing}=${counts.get(standing) ?? 0}`).join(" ")}`,
			);
			for (const finding of findings.filter(
				(finding) => finding.standing !== "clean",
			)) {
				console.log(
					`  ${finding.caseType} ${finding.caseId}: ${finding.standing}: ${finding.detail}`,
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
		`\n${apps.length} app(s); ${actionable} safe repair(s); ${ambiguous} ambiguous/topology finding(s); ${failures} scan failure(s).`,
	);
	if (actionable > 0 && options.prod === true) {
		console.log(
			"\nAfter the new revision owns 100% traffic and every old request has drained, run the immutable write-capable Job:\n" +
				"  python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova --region=us-central1 " +
				"--job=commcare-nova-case-parent-relationship-repair --image=$NOVA_MAINTENANCE_IMAGE --wait-seconds=3060 " +
				"--execution-arg=case-parent-relationship-repair.cjs --execution-arg=--execute " +
				`--execution-arg=--confirm-old-revision-drained${options.app === undefined ? "" : ` --execution-arg=--app --execution-arg=${options.app}`}`,
		);
		console.log(
			`\nIndependent proof afterward:\n  npx tsx scripts/scan-case-parent-relationships.ts --prod${scopeArgs()}`,
		);
	}
	if (actionable > 0 || ambiguous > 0 || failures > 0) process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
