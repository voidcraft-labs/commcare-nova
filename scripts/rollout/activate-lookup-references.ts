/**
 * The lookup-reference activation controller.
 *
 * Turning the dormant vocabulary on is not a migration: a deploy-blocking Job
 * runs BEFORE its revision takes traffic, so a Job-time floor raise would revoke
 * every open tab into a bundle that predates the cutoff. Activation instead runs
 * here, after the capable revision is already serving, as four phases an
 * operator advances by hand:
 *
 *   status   read-only: compatibility state, epochs, holders, leases, and the
 *            capability every traffic-receiving Cloud Run revision declares
 *   prepare  reconcile durable epochs to the live traffic split, then open an
 *            uninterrupted runtime-reader epoch
 *   raise    re-check the split, then ONE transaction lifting the
 *            stream-receiver and runtime-reader floors, switches still off
 *   enable   prove the drain, then flip the switches
 *
 * The phases are separated by enforced waits (an epoch at least as long as the
 * request cap, then a drain of the full stream lease), so the controller is
 * resumable rather than long-running: each phase re-derives its preconditions
 * from durable state and prints when the next one becomes legal. Nothing is
 * checkpointed to a file — the compatibility row and the epoch table ARE the
 * checkpoint.
 *
 * Every phase holds the deployment-cutover gate in its SESSION form on one
 * pinned connection, so a deploy, a second controller, or a compatibility
 * mutation cannot interleave with the phase's own transactions (which re-take
 * the gate in its transaction form on that same session).
 *
 * Writes are opt-in: without `--execute` each phase runs its real transaction
 * against real locks and then rolls back, which rehearses the preconditions
 * instead of merely describing them.
 */

import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { withDeploymentCutoverSession } from "@/lib/db/deploymentCutoverGate";
import { getAppDb } from "@/lib/db/pg";
import {
	type ActivationSwitch,
	enableLookupReferenceActivationInTransaction,
	type LookupReferenceCompatibilityState,
	prepareRuntimeReaderTrafficEpochInTransaction,
	type ReadReceivingRevisionCapabilities,
	type ReceivingRevisionCapability,
	type RolloutCompatibilityStatus,
	raiseMinimumRuntimeReaderVersionInTransaction,
	raiseMinimumStreamReceiverVersionInTransaction,
	readRolloutCompatibilityStatusInTransaction,
	reconcileReceivingRevisionCapabilitiesInTransaction,
} from "@/lib/db/rolloutCompatibility";
import { runtimeHolderBlocksTarget } from "@/lib/db/runtimeReaderHolders";
import {
	RUNTIME_CAPABILITIES,
	STREAM_LEASE_TTL_SECONDS,
} from "@/lib/runtimeCapabilities";
import { readCloudRunCapabilities } from "../lib/cloudRunCapabilities";
import { runMain } from "../lib/main";
import { targetProdDb } from "../lib/prodDb";

const execFileAsync = promisify(execFile);

/** The floors this image's manifest is built to serve. */
const RECEIVER_TARGET = RUNTIME_CAPABILITIES.streamReceiverVersion;
const READER_TARGET = RUNTIME_CAPABILITIES.runtimeReaderVersion;
const EPOCH_SECONDS = RUNTIME_CAPABILITIES.cloudRunRequestSeconds;

/**
 * Every switch the cutover opens, in one transaction. The nonce switch rides
 * along because its floor precondition — runtime reader v1 — is satisfied by the
 * same raise, and because it is irreversible: splitting it into its own later
 * act would only widen the window in which holders use two identity rules.
 */
const ACTIVATION_SWITCHES: readonly ActivationSwitch[] = [
	"carrier_commits_enabled",
	"destructive_schema_actions_enabled",
	"project_moves_enabled",
	"case_operations_enabled",
	"run_holder_nonce_enforced",
];

/** Audit scans that must be clean before the switches flip. */
const AUDIT_SCANS = [
	"scripts/scan-lookup-reference-edges.ts",
	"scripts/scan-case-id-storage.ts",
] as const;

/** Thrown to roll a rehearsed phase back; never reaches the operator. */
class DryRunRollback extends Error {
	constructor(readonly outcome: unknown) {
		super("dry run");
	}
}

interface ControllerOptions {
	phase: string;
	execute?: boolean;
	prod?: boolean;
	dbUser?: string;
	service: string;
	region: string;
}

/**
 * The control tables are owned by the migration role; the runtime role has
 * read-only access and a developer's own IAM user is provisioned read-only
 * (`scripts/lib/prodDb.ts`). Writing phases must therefore run as this user.
 */
const MIGRATION_SERVICE_ACCOUNT =
	"nova-migrate@commcare-nova.iam.gserviceaccount.com";
const MIGRATION_DB_USER = "nova-migrate@commcare-nova.iam";

/** Fail before the first write rather than partway through a phase. */
function requireWriteIdentity(options: ControllerOptions): void {
	if (options.execute !== true || options.prod !== true) return;
	if (process.env.NOVA_DB_USER === MIGRATION_DB_USER) return;
	throw new Error(
		[
			`Refusing to write to production as ${process.env.NOVA_DB_USER ?? "an underived identity"}.`,
			"",
			`    expected: --db-user ${MIGRATION_DB_USER}`,
			"",
			"--prod connects as your own gcloud identity, which is provisioned",
			"read-only on this database, so the first control-table write would fail",
			"partway through the phase. Reach the migration identity with an",
			"impersonated ADC credential — an ephemeral serviceAccountTokenCreator",
			`grant on ${MIGRATION_SERVICE_ACCOUNT} — then pass`,
			"--db-user, and revoke the grant when the cutover is done.",
		].join("\n"),
	);
}

function seconds(value: number): string {
	if (value < 60) return `${Math.ceil(value)}s`;
	const minutes = Math.ceil(value / 60);
	return minutes < 60
		? `${minutes}m`
		: `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function heading(text: string): void {
	console.log(`\n${text}\n${"─".repeat(text.length)}`);
}

function reportCompatibility(state: LookupReferenceCompatibilityState): void {
	console.log(
		`  floors      writer ${state.minimumWriterVersion} · receiver ${state.minimumStreamReceiverVersion} · reader ${state.minimumRuntimeReaderVersion}`,
	);
	console.log(
		`  switches    carrier ${state.carrierCommitsEnabled} · schema ${state.destructiveSchemaActionsEnabled} · moves ${state.projectMovesEnabled} · operations ${state.caseOperationsEnabled} · nonce ${state.runHolderNonceEnforced}`,
	);
	console.log(`  updated     ${state.updatedAt.toISOString()}`);
}

/** Holders and leases that would block the cutoff, at the floors being targeted. */
function drainBlockers(status: RolloutCompatibilityStatus) {
	return {
		holders: status.runtimeHolders.filter((entry) =>
			runtimeHolderBlocksTarget(entry.holder, READER_TARGET),
		),
		leases: status.activeStreamLeases.filter(
			(lease) => lease.receiverVersion < RECEIVER_TARGET,
		),
	};
}

function reportDrain(status: RolloutCompatibilityStatus): boolean {
	const { holders, leases } = drainBlockers(status);
	console.log(
		`  holders     ${status.runtimeHolders.length} present, ${holders.length} below reader v${READER_TARGET}`,
	);
	for (const entry of holders) {
		console.log(
			`              ${entry.appId} ${entry.holder.lifecycle} v${entry.holder.effectiveVersion}`,
		);
	}
	console.log(
		`  leases      ${status.activeStreamLeases.length} unexpired, ${leases.length} below receiver v${RECEIVER_TARGET}`,
	);
	for (const lease of leases) {
		console.log(
			`              ${lease.appId}/${lease.connectionId} v${lease.receiverVersion} until ${lease.expiresAt.toISOString()}`,
		);
	}
	return holders.length === 0 && leases.length === 0;
}

/** A revision that cannot honor one of the floors this cutover targets. */
function revisionBlocks(revision: ReceivingRevisionCapability): boolean {
	return (
		revision.runtimeReaderVersion < READER_TARGET ||
		revision.streamReceiverVersion < RECEIVER_TARGET
	);
}

function reportRevisionSet(
	revisions: readonly ReceivingRevisionCapability[],
): void {
	console.log(`  revisions   ${revisions.length} receiving traffic`);
	for (const revision of revisions) {
		console.log(
			`              ${revision.revision} reader v${revision.runtimeReaderVersion} · receiver v${revision.streamReceiverVersion} ${
				revisionBlocks(revision) ? "BLOCKS" : "ok"
			}`,
		);
	}
}

/**
 * Read the split fresh and refuse if anything serving traffic would be revoked.
 * Both floors are checked: reader and receiver are independent declarations, so
 * a revision can satisfy one and be revoked by the other.
 */
async function requireCapableRevisions(
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<readonly ReceivingRevisionCapability[]> {
	const revisions = await readReceiving();
	const blockers = revisions.filter(revisionBlocks);
	if (blockers.length > 0) {
		throw new Error(
			[
				`These revisions are serving traffic but cannot honor reader v${READER_TARGET} / receiver v${RECEIVER_TARGET}:`,
				...blockers.map(
					(revision) =>
						`  ${revision.revision} reader v${revision.runtimeReaderVersion} receiver v${revision.streamReceiverVersion}`,
				),
				"",
				"Compatibility floors are monotonic, so raising past them would revoke",
				"their clients with no way back short of a new deploy. Route traffic",
				"entirely to capable revisions, then re-run.",
			].join("\n"),
		);
	}
	return revisions;
}

async function runAuditScans(prod: boolean): Promise<void> {
	for (const scan of AUDIT_SCANS) {
		const args = ["tsx", scan, ...(prod ? ["--prod"] : [])];
		console.log(`  running     npx ${args.join(" ")}`);
		const indent = (text: string) =>
			text
				.trimEnd()
				.split("\n")
				.map((line) => `              ${line}`)
				.join("\n");
		try {
			const { stdout } = await execFileAsync("npx", args, {
				maxBuffer: 64 * 1024 * 1024,
			});
			console.log(indent(stdout));
		} catch (error) {
			// The scans exit 1 for findings AND for any fatal error (a lapsed
			// credential, a dropped connection). Print what they said rather than
			// asserting one diagnosis: mid-cutover, sending the operator hunting for
			// findings that do not exist costs more than the ambiguity.
			const output = error as { stdout?: string; stderr?: string };
			if (output.stdout) console.log(indent(output.stdout));
			if (output.stderr) console.log(indent(output.stderr));
			throw new Error(
				`${scan} exited nonzero — either the fleet has findings or the scan itself failed. Its output is above; activation stops here either way.`,
				{ cause: error },
			);
		}
	}
}

/** Run a phase's transactions on one pinned connection holding the session gate. */
async function underCutoverSession(
	options: ControllerOptions,
	body: (
		session: Awaited<ReturnType<typeof getAppDb>>,
		commit: boolean,
	) => Promise<void>,
): Promise<void> {
	const db = await getAppDb();
	const commit = options.execute === true;
	await withDeploymentCutoverSession(db, (session) => body(session, commit));
	if (!commit) {
		console.log("\n  DRY RUN — rolled back. Re-run with --execute to commit.");
	}
}

/**
 * One transaction that proves its preconditions and then either commits or
 * rolls back. The proven outcome is returned EITHER way, so a rehearsal reports
 * exactly what it established instead of only that it rolled back.
 */
async function provenTransaction<T>(
	session: Awaited<ReturnType<typeof getAppDb>>,
	commit: boolean,
	body: (
		tx: Parameters<typeof readRolloutCompatibilityStatusInTransaction>[0],
	) => Promise<T>,
): Promise<T> {
	try {
		return await session.transaction().execute(async (tx) => {
			const outcome = await body(tx);
			if (!commit) throw new DryRunRollback(outcome);
			return outcome;
		});
	} catch (error) {
		if (error instanceof DryRunRollback) return error.outcome as T;
		throw error;
	}
}

async function statusPhase(
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<void> {
	const db = await getAppDb();
	const status = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(readRolloutCompatibilityStatusInTransaction);

	heading("Compatibility state");
	reportCompatibility(status.compatibility);
	console.log(
		`  epochs      ${
			status.runtimeTrafficEpochs
				.map(
					(epoch) =>
						`v${epoch.targetVersion} since ${epoch.continuousTrafficSince.toISOString()}`,
				)
				.join(", ") || "none"
		}`,
	);

	heading("Drain");
	const drained = reportDrain(status);

	heading("Cloud Run");
	reportRevisionSet(await readReceiving());

	heading("Next");
	console.log(
		`  targets     receiver v${RECEIVER_TARGET} · reader v${READER_TARGET}`,
	);
	if (status.compatibility.minimumRuntimeReaderVersion < READER_TARGET) {
		const epoch = status.runtimeTrafficEpochs.find(
			(candidate) => candidate.targetVersion === READER_TARGET,
		);
		if (!epoch) {
			console.log("  phase       prepare (no runtime epoch is open)");
		} else {
			const ready =
				epoch.continuousTrafficSince.getTime() + EPOCH_SECONDS * 1_000;
			const remaining = (ready - status.observedAt.getTime()) / 1_000;
			console.log(
				remaining > 0
					? `  phase       raise, legal in ${seconds(remaining)} (${new Date(ready).toISOString()})`
					: "  phase       raise",
			);
		}
		return;
	}

	const ready =
		status.compatibility.updatedAt.getTime() + STREAM_LEASE_TTL_SECONDS * 1_000;
	const remaining = (ready - status.observedAt.getTime()) / 1_000;
	console.log(
		remaining > 0
			? `  phase       enable, drain completes in ${seconds(remaining)} (${new Date(ready).toISOString()})`
			: `  phase       enable${drained ? "" : " — BLOCKED until the drain above is empty"}`,
	);
}

async function preparePhase(
	options: ControllerOptions,
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<void> {
	await underCutoverSession(options, async (session, commit) => {
		// TWO transactions, not one: each reads the control plane before taking
		// the compatibility row FOR UPDATE. Combining them would leave that row
		// locked across the second gcloud round-trip, and every guarded write in
		// the fleet — app creation, every blueprint commit — takes it FOR SHARE.
		const reconciled = await provenTransaction(session, commit, (tx) =>
			reconcileReceivingRevisionCapabilitiesInTransaction(tx, readReceiving),
		);
		const epoch = await provenTransaction(session, commit, (tx) =>
			prepareRuntimeReaderTrafficEpochInTransaction(
				tx,
				READER_TARGET,
				readReceiving,
			),
		);

		heading("Prepared");
		reportCompatibility(reconciled.compatibility);
		console.log(
			`  epoch       v${epoch.targetVersion} since ${epoch.continuousTrafficSince.toISOString()}`,
		);
		console.log(
			`  raise legal ${new Date(
				epoch.continuousTrafficSince.getTime() + EPOCH_SECONDS * 1_000,
			).toISOString()} (${seconds(EPOCH_SECONDS)} of uninterrupted compatible traffic)`,
		);
	});
}

async function raisePhase(
	options: ControllerOptions,
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<void> {
	await underCutoverSession(options, async (session, commit) => {
		// The floors are monotonic, so this is the last moment the traffic split
		// can still be checked. An hour of enforced waiting separates `prepare`
		// from here — long enough for a rollback deploy or a pinned split to put
		// an incapable revision back in service, which reconciliation must clear
		// from the epoch table before the raise consults it.
		const reconciled = await provenTransaction(session, commit, (tx) =>
			reconcileReceivingRevisionCapabilitiesInTransaction(tx, readReceiving),
		);
		heading("Traffic");
		reportRevisionSet(await requireCapableRevisions(readReceiving));
		console.log(
			`  epochs      ${
				reconciled.runtimeTrafficEpochs
					.map((epoch) => `v${epoch.targetVersion}`)
					.join(", ") || "none (reconciliation cleared them)"
			}`,
		);

		const raised = await provenTransaction(session, commit, async (tx) => {
			await raiseMinimumStreamReceiverVersionInTransaction(tx, RECEIVER_TARGET);
			return raiseMinimumRuntimeReaderVersionInTransaction(tx, READER_TARGET);
		});

		heading("Floors raised");
		reportCompatibility(raised);
		console.log(
			`  enable legal ${new Date(
				raised.updatedAt.getTime() + STREAM_LEASE_TTL_SECONDS * 1_000,
			).toISOString()} (${seconds(STREAM_LEASE_TTL_SECONDS)} drain: the request cap plus stream grace)`,
		);
	});
}

async function enablePhase(
	options: ControllerOptions,
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<void> {
	const db = await getAppDb();
	const preflight = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(readRolloutCompatibilityStatusInTransaction);

	heading("Drain preflight");
	const elapsed =
		(preflight.observedAt.getTime() -
			preflight.compatibility.updatedAt.getTime()) /
		1_000;
	console.log(
		`  since raise ${seconds(elapsed)} of the required ${seconds(STREAM_LEASE_TTL_SECONDS)}`,
	);
	if (elapsed < STREAM_LEASE_TTL_SECONDS) {
		throw new Error(
			`The drain is incomplete: ${seconds(
				STREAM_LEASE_TTL_SECONDS - elapsed,
			)} remain before every pre-cutoff request, stream, and lease is guaranteed to have ended.`,
		);
	}
	if (!reportDrain(preflight)) {
		throw new Error(
			"Below-floor holders or leases are still live; activation would strand them.",
		);
	}

	heading("Cloud Run preflight");
	reportRevisionSet(await requireCapableRevisions(readReceiving));

	heading("Audit scans");
	await runAuditScans(options.prod === true);

	await underCutoverSession(options, async (session, commit) => {
		const state = await provenTransaction(session, commit, async (tx) => {
			await requireCapableRevisions(readReceiving);
			return enableLookupReferenceActivationInTransaction(
				tx,
				ACTIVATION_SWITCHES,
			);
		});

		heading("Activated");
		reportCompatibility(state);
	});
}

const program = new Command();
program
	.name("activate-lookup-references")
	.description(
		"Phased runtime activation of the lookup-reference, case-operation, schema, and Project-move vocabulary. Dry run unless --execute is passed.",
	)
	.option("--phase <phase>", "status | prepare | raise | enable", "status")
	.option(
		"--execute",
		"commit the phase instead of rehearsing and rolling back",
	)
	.option("--prod", "target production Cloud SQL and the production service")
	.option(
		"--db-user <iam-user>",
		"Cloud SQL IAM user for the writing phases (the migration identity)",
	)
	.option("--service <name>", "Cloud Run service", "commcare-nova")
	.option("--region <region>", "Cloud Run region", "us-central1")
	.addHelpText(
		"after",
		[
			"",
			"Phases run in order, separated by enforced waits:",
			"  prepare -> (request cap) -> raise -> (stream lease drain) -> enable",
			"Each re-derives its preconditions from durable state, so re-running a",
			"phase is safe and resuming after an interruption needs no saved file.",
			"",
			"Cloud Run reads use the gcloud CLI, so `gcloud auth login` must be",
			"current.",
			"",
			`Writing to production needs --db-user ${MIGRATION_DB_USER}:`,
			"--prod otherwise connects as YOUR gcloud identity, which is provisioned",
			"read-only, and the runtime service account holds no write grant on the",
			"control tables either. Reach that identity with an impersonated ADC",
			"credential (an ephemeral serviceAccountTokenCreator grant on",
			`${MIGRATION_SERVICE_ACCOUNT}), and revoke it afterwards.`,
			"",
			"Examples:",
			"  $ npx tsx scripts/rollout/activate-lookup-references.ts --prod",
			`  $ npx tsx scripts/rollout/activate-lookup-references.ts --prod --phase prepare --execute --db-user ${MIGRATION_DB_USER}`,
			"",
		].join("\n"),
	);
program.parse();
const options = program.opts<ControllerOptions>();
if (options.dbUser !== undefined) process.env.NOVA_DB_USER = options.dbUser;
if (options.prod === true) targetProdDb();

runMain(async () => {
	const readReceiving = readCloudRunCapabilities({
		service: options.service,
		region: options.region,
	});
	try {
		requireWriteIdentity(options);
		if (options.phase === "status") await statusPhase(readReceiving);
		else if (options.phase === "prepare")
			await preparePhase(options, readReceiving);
		else if (options.phase === "raise")
			await raisePhase(options, readReceiving);
		else if (options.phase === "enable")
			await enablePhase(options, readReceiving);
		else {
			throw new Error(
				`Unknown phase ${JSON.stringify(options.phase)}. Expected status, prepare, raise, or enable.`,
			);
		}
	} finally {
		await closeCaseStoreDatabase();
	}
});
