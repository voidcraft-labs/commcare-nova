/**
 * What each mode of the two cutover scripts does, against a database handle,
 * returning its report. The scripts parse their arguments and print; the
 * tests call these with their own database.
 */

import type { Kysely } from "kysely";
import { runCaseStoreMigrationsWithReport } from "@/lib/case-store/migrate";
import type { AppDatabase } from "@/lib/db/pg";
import { credentialOrder } from "./credentials";
import { readHolderCensus, settleHolders } from "./holders";
import {
	type DecryptClock,
	KmsDecryptRefusedError,
	type KmsDecryptTransport,
	proveDecrypt,
	realClock,
} from "./kmsDecrypt";
import {
	type BuildPlanOptions,
	planHasBlockers,
	planHasTransientDeployments,
	readFleetSource,
	readPlannedFleet,
} from "./plan";
import {
	CutoverReport,
	deploymentLines,
	fleetLine,
	outcomeLine,
	planInputs,
	planSections,
	type ReportMode,
	type ReportOutcome,
	writerFields,
} from "./report";
import {
	CutoverStoppedError,
	readMarkedAppCounts,
	runFleetTransaction,
	type WriterReport,
	type WriterStep,
} from "./writer";

export interface RunResult {
	readonly report: CutoverReport;
	readonly outcome: ReportOutcome;
	/** 1 when a blocker, a live holder, a transient read, a digest refusal or a failed proof stopped the run. */
	readonly exitCode: 0 | 1;
}

function finish(report: CutoverReport, outcome: ReportOutcome): RunResult {
	outcomeLine(report, outcome);
	return {
		report,
		outcome,
		exitCode:
			outcome.outcome === "stopped" || outcome.outcome === "failed" ? 1 : 0,
	};
}

/** The modes of the migrate script. */
export type MigrateMode = Exclude<ReportMode, "scan">;

export interface MigrateOptions {
	readonly mode: MigrateMode;
	/** With `execute`, the digest the rehearsal printed. */
	readonly expectPlanDigest?: string;
	readonly transientAsUnreadable?: boolean;
	/** Read no HQ and decrypt nothing. */
	readonly withoutHq?: boolean;
	/** `--prove-decrypt`'s KMS transport and clock. */
	readonly kms?: () => KmsDecryptTransport;
	readonly clock?: DecryptClock;
	/** How deployments are read; absent where no HQ read is made. */
	readonly plan?: BuildPlanOptions;
	/** Tests only: throw right after the named step of the fleet transaction. */
	readonly failAfter?: WriterStep;
}

/**
 * `--prove-decrypt`: decrypt the stored key of the first member, in user id
 * order, whose key qualifies for a deployment the plan holds.
 */
export async function proveStoredKeyDecrypt(
	db: Kysely<AppDatabase>,
	transport: () => KmsDecryptTransport,
	clock: DecryptClock = realClock,
): Promise<{
	outcome: "ok" | "failed" | "no-key";
	refusal?: KmsDecryptRefusedError;
}> {
	const ciphertext = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const source = await readFleetSource(tx);
			const qualifying = new Set<string>();
			for (const app of source.apps) {
				const members = source.projects.get(app.projectId)?.members ?? [];
				for (const deployment of app.deployments) {
					for (const userId of credentialOrder(deployment, members)) {
						qualifying.add(userId);
					}
				}
			}
			const [first] = [...qualifying].sort();
			if (first === undefined) return null;
			const row = await tx
				.selectFrom("user_settings")
				.select("commcare_api_key")
				.where("user_id", "=", first)
				.executeTakeFirstOrThrow();
			return row.commcare_api_key;
		});
	if (ciphertext === null) return { outcome: "no-key" };
	try {
		return { outcome: await proveDecrypt(ciphertext, transport(), clock) };
	} catch (error) {
		if (error instanceof KmsDecryptRefusedError) {
			return { outcome: "failed", refusal: error };
		}
		throw error;
	}
}

/** One run of the migrate script. */
export async function runMigrate(
	db: Kysely<AppDatabase>,
	options: MigrateOptions,
): Promise<RunResult> {
	const { mode } = options;
	const report = new CutoverReport(mode);
	const counts = await readMarkedAppCounts(db);
	if (counts.apps > 0 && counts.marked === counts.apps) {
		report.line("fleet", { apps: counts.apps, appsMarked: counts.marked });
		return finish(report, { outcome: "already-applied" });
	}
	if (counts.marked > 0) {
		throw new Error(
			`${counts.marked} of ${counts.apps} apps carry the hq-round-trip-emission horizon and the rest do not. No run of this writer leaves that state, so it refuses to read the fleet. Restore the database from the window's restore point before running it again.`,
		);
	}

	if (mode === "settle-holders") {
		const settled = await settleHolders();
		const census = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => readHolderCensus(tx));
		report.line("fleet", { apps: counts.apps });
		report.line("holders", {
			settledApps: settled.appsSettled,
			settledSessions: settled.sessionsSettled,
			live: census.liveApps.length + census.liveSessions.length,
			lapsedOrPaused:
				census.settleableApps.length + census.settleableSessions.length,
			unsettledHolds:
				census.unsettledApps.length + census.unsettledSessions.length,
		});
		return finish(report, { outcome: "ok" });
	}
	if (mode === "prove-decrypt") {
		report.line("fleet", { apps: counts.apps });
		const proof = await proveStoredKeyDecrypt(
			db,
			options.kms ??
				(() => {
					throw new Error("--prove-decrypt needs a KMS transport.");
				}),
			options.clock,
		);
		if (proof.refusal !== undefined) {
			report.line("decrypt", {
				status: proof.refusal.status,
				refusal: proof.refusal.kind,
			});
		}
		return finish(report, { outcome: proof.outcome });
	}

	if (mode === "rehearse" || mode === "execute") {
		await runCaseStoreMigrationsWithReport(db as unknown as Kysely<unknown>);
	}
	const readStarted = performance.now();
	const fleet = await readPlannedFleet(
		db,
		options.withoutHq === true ? {} : (options.plan ?? {}),
	);
	const readMilliseconds = Math.round(performance.now() - readStarted);
	const stoppedBy = [
		...(planHasBlockers(fleet.build.plan) ? (["blocker"] as const) : []),
		...(fleet.holders.liveApps.length + fleet.holders.liveSessions.length > 0
			? (["holder"] as const)
			: []),
		...(planHasTransientDeployments(fleet.build.plan)
			? (["transient"] as const)
			: []),
	];
	const digestMoved =
		mode === "execute" && fleet.build.plan.digest !== options.expectPlanDigest;

	let writer: WriterReport | null = null;
	let writerStop: CutoverStoppedError | null = null;
	if (
		(mode === "rehearse" || mode === "execute") &&
		stoppedBy.length === 0 &&
		!digestMoved
	) {
		try {
			writer = await runFleetTransaction(db, {
				mode,
				build: fleet.build,
				...(options.failAfter !== undefined && {
					failAfter: options.failAfter,
				}),
			});
		} catch (error) {
			if (!(error instanceof CutoverStoppedError)) throw error;
			writerStop = error;
		}
	}

	fleetLine(report, fleet.source, fleet.databaseBytes, {
		...planInputs(fleet.build),
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		readMilliseconds,
		...(writer === null ? {} : writerFields(writer)),
	});
	planSections(report, fleet.source, fleet.build, fleet.holders);
	deploymentLines(report, fleet.build);
	if (digestMoved) {
		return finish(report, { outcome: "stopped", stoppedBy: ["digest"] });
	}
	if (stoppedBy.length > 0) {
		return finish(report, { outcome: "stopped", stoppedBy });
	}
	if (writerStop !== null) {
		// An app or the marker that moved under the locks is a fleet that no
		// longer matches the plan, which the report states as its digest.
		return finish(report, {
			outcome: "stopped",
			stoppedBy: [
				writerStop.code === "holder"
					? "holder"
					: writerStop.code === "blocker"
						? "blocker"
						: "digest",
			],
		});
	}
	return finish(report, { outcome: "ok" });
}

/** One run of the scan. */
export async function runScan(
	db: Kysely<AppDatabase>,
	options: { readonly appId?: string } = {},
): Promise<RunResult> {
	const fleet = await readPlannedFleet(db, options);
	const report = new CutoverReport("scan");
	fleetLine(report, fleet.source, fleet.databaseBytes);
	planSections(report, fleet.source, fleet.build, fleet.holders);
	const stoppedBy = [
		...(planHasBlockers(fleet.build.plan) ? (["blocker"] as const) : []),
		...(fleet.holders.liveApps.length + fleet.holders.liveSessions.length > 0
			? (["holder"] as const)
			: []),
		...(planHasTransientDeployments(fleet.build.plan)
			? (["transient"] as const)
			: []),
	];
	return finish(
		report,
		stoppedBy.length === 0
			? { outcome: "ok" }
			: { outcome: "stopped", stoppedBy },
	);
}
