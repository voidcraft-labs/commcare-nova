/**
 * WRITER — backfill explicit retirement state for historical orphaned active
 * case-type schemas. Dry-run by default; `--execute` is required to write.
 *
 * Each app is re-read under `apps FOR UPDATE`. Candidate detection, inactive
 * schema writes, and the Blueprint snapshot therefore share the same database
 * transaction. Retained cases and parked values are never modified. Concurrent
 * expression-index cleanup runs after commit from durable pending state.
 */

import "dotenv/config";
import { Command } from "commander";
import type { Transaction } from "kysely";
import {
	closeCaseStoreDatabase,
	type Database,
	getCaseStoreDatabase,
} from "../lib/case-store/postgres/connection";
import {
	drainRetiredCaseTypeSchemaIndexes,
	retireCaseTypeSchemasPhaseA,
} from "../lib/case-store/postgres/schemaRetirement";
import { buildCaseTypeMap } from "../lib/case-store/store";
import { getAppDb, withAppTx } from "../lib/db/pg";
import { safePersistedSequence } from "../lib/utils/persistedSequence";
import { findCaseTypeSchemaRetirementFindings } from "./lib/caseTypeSchemaRetirement";
import { loadPersistedBlueprintInTransaction } from "./lib/loadPersistedBlueprint";
import { runMain } from "./lib/main";

interface Options {
	execute?: boolean;
	app?: string;
	confirmOldRevisionDrained?: boolean;
}

const program = new Command();
program
	.name("migrate-case-type-schema-retirement")
	.description(
		"Mark historical orphaned active case_type_schemas rows inactive. Dry-run by default.",
	)
	.option("--execute", "write retirement state and converge indexes")
	.option(
		"--confirm-old-revision-drained",
		"confirm the new revision has 100% traffic and all old-revision requests have drained (required with --execute)",
	)
	.option("--app <appId>", "scope the migration to one app")
	.addHelpText(
		"after",
		"\nExamples:\n" +
			"  $ npx tsx scripts/migrate-case-type-schema-retirement.ts\n" +
			"  $ npx tsx scripts/migrate-case-type-schema-retirement.ts --execute --confirm-old-revision-drained\n",
	);
program.parse();
const {
	execute = false,
	app: appId,
	confirmOldRevisionDrained = false,
} = program.opts<Options>();

async function main() {
	if (execute && !confirmOldRevisionDrained) {
		throw new Error(
			"--execute requires --confirm-old-revision-drained. Run only after the new revision has 100% traffic and every old-revision request has drained; otherwise an old writer can create a new orphan after this backfill.",
		);
	}
	const appDb = await getAppDb();
	const caseDb = await getCaseStoreDatabase();
	let query = appDb.selectFrom("apps").select(["id", "app_name"]);
	if (appId !== undefined) query = query.where("id", "=", appId);
	const apps = await query.execute();
	if (appId !== undefined && apps.length === 0) {
		throw new Error(`App ${appId} not found.`);
	}

	console.log(
		execute
			? "Retiring historical orphaned case-type schemas…\n"
			: "DRY RUN — nothing writes without --execute…\n",
	);
	let retiredCount = 0;
	const failedApps: string[] = [];
	for (const app of apps) {
		try {
			if (!execute) {
				const blueprint = await withAppTx((tx) =>
					loadPersistedBlueprintInTransaction(tx, app.id),
				);
				if (blueprint === null) continue;
				const findings = await findCaseTypeSchemaRetirementFindings(
					caseDb,
					app.id,
					blueprint,
				);
				for (const candidate of findings) {
					console.log(
						`${app.id} (${app.app_name || "unnamed"}): ${candidate.issues.join(", ")} for ${candidate.caseType} ` +
							`(${candidate.caseCount} retained case(s), ${candidate.expressionIndexCount} expression index(es))`,
					);
				}
				retiredCount += findings.length;
				continue;
			}

			const prepared = await withAppTx(async (tx) => {
				const locked = await tx
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", app.id)
					.forUpdate()
					.executeTakeFirst();
				if (locked === undefined) return undefined;
				const blueprint = await loadPersistedBlueprintInTransaction(tx, app.id);
				if (blueprint === null) return undefined;
				const caseTx = tx as unknown as Transaction<Database>;
				const findings = await findCaseTypeSchemaRetirementFindings(
					caseTx,
					app.id,
					blueprint,
				);
				const candidates = findings.filter((finding) =>
					finding.issues.includes("active-without-blueprint"),
				);
				const cleanupTypes = findings
					.filter((finding) =>
						finding.issues.includes("inactive-index-cleanup"),
					)
					.map((finding) => finding.caseType);
				if (candidates.length === 0 && cleanupTypes.length === 0)
					return undefined;
				const retiredTypes =
					candidates.length === 0
						? []
						: await retireCaseTypeSchemasPhaseA(caseTx, {
								appId: app.id,
								desiredSeq: safePersistedSequence(
									locked.mutation_seq,
									`apps.mutation_seq for case-type retirement backfill ${app.id}`,
								),
								caseTypes: candidates.map((candidate) => candidate.caseType),
								fallbackCaseTypeSchemas: buildCaseTypeMap(blueprint),
							});
				return { caseTypes: [...new Set([...retiredTypes, ...cleanupTypes])] };
			});
			if (prepared === undefined) continue;
			await drainRetiredCaseTypeSchemaIndexes(
				caseDb,
				app.id,
				prepared.caseTypes,
			);
			retiredCount += prepared.caseTypes.length;
			console.log(
				`${app.id} (${app.app_name || "unnamed"}): converged retirement state for ${prepared.caseTypes.join(", ")}`,
			);
		} catch (error) {
			failedApps.push(app.id);
			console.log(
				`${app.id}: FAILED — ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	let verificationFindingCount = 0;
	if (execute) {
		for (const app of apps) {
			try {
				const findings = await withAppTx(async (tx) => {
					const blueprint = await loadPersistedBlueprintInTransaction(
						tx,
						app.id,
					);
					if (blueprint === null) return [];
					return findCaseTypeSchemaRetirementFindings(
						tx as unknown as Transaction<Database>,
						app.id,
						blueprint,
					);
				});
				verificationFindingCount += findings.length;
				for (const finding of findings) {
					console.log(
						`${app.id}: VERIFICATION FINDING — ${finding.caseType}: ${finding.issues.join(", ")}`,
					);
				}
			} catch (error) {
				if (!failedApps.includes(app.id)) failedApps.push(app.id);
				console.log(
					`${app.id}: VERIFICATION FAILED — ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	console.log(
		execute
			? `Done: ${retiredCount} schema row(s) retired` +
					(failedApps.length === 0
						? ""
						: `; failed apps: ${failedApps.join(", ")}`) +
					`; post-write verification: ${verificationFindingCount} finding(s). ` +
					"Re-run scan-case-type-schema-retirement.ts; it must also report zero findings."
			: `Dry run: ${retiredCount} schema lifecycle finding(s) require action. After the new revision has 100% traffic and old requests have drained, re-run with --execute --confirm-old-revision-drained.`,
	);
	if (failedApps.length > 0 || verificationFindingCount > 0)
		process.exitCode = 1;
	await closeCaseStoreDatabase();
}

runMain(main);
