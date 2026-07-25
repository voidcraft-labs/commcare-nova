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
 *   raise    ONE transaction lifting the stream-receiver and runtime-reader
 *            floors, with every feature switch still off
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
	service: string;
	region: string;
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

async function reportRevisions(
	readReceiving: ReadReceivingRevisionCapabilities,
): Promise<void> {
	const revisions = await readReceiving();
	console.log(`  revisions   ${revisions.length} receiving traffic`);
	for (const revision of revisions) {
		const verdict =
			revision.runtimeReaderVersion >= READER_TARGET ? "ok" : "BLOCKS";
		console.log(
			`              ${revision.revision} reader v${revision.runtimeReaderVersion} ${verdict}`,
		);
	}
}

async function runAuditScans(prod: boolean): Promise<void> {
	for (const scan of AUDIT_SCANS) {
		const args = ["tsx", scan, ...(prod ? ["--prod"] : [])];
		console.log(`  running     npx ${args.join(" ")}`);
		try {
			const { stdout } = await execFileAsync("npx", args, {
				maxBuffer: 64 * 1024 * 1024,
			});
			console.log(
				stdout
					.trimEnd()
					.split("\n")
					.map((line) => `              ${line}`)
					.join("\n"),
			);
		} catch (error) {
			throw new Error(
				`${scan} reported findings; activation stops until the fleet is clean.`,
				{ cause: error },
			);
		}
	}
}

/**
 * Run one phase under the session gate. The phase body owns its own
 * transactions on the pinned session; `--execute` decides whether the LAST one
 * commits, so a rehearsal exercises the same locks and preconditions.
 */
async function underCutoverSession<T>(
	body: (
		session: Awaited<ReturnType<typeof getAppDb>>,
		commit: boolean,
	) => Promise<T>,
	options: ControllerOptions,
): Promise<T | undefined> {
	const db = await getAppDb();
	return withDeploymentCutoverSession(db, async (session) => {
		try {
			return await body(session, options.execute === true);
		} catch (error) {
			if (error instanceof DryRunRollback) {
				console.log(
					"\n  DRY RUN — rolled back. Re-run with --execute to commit.",
				);
				return undefined;
			}
			throw error;
		}
	});
}

/** Commit or roll back the transaction the phase just proved. */
async function settle<T>(outcome: T, commit: boolean): Promise<T> {
	if (commit) return outcome;
	throw new DryRunRollback(outcome);
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
	await reportRevisions(readReceiving);

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
	await underCutoverSession(async (session, commit) => {
		const outcome = await session.transaction().execute(async (tx) => {
			const reconciled =
				await reconcileReceivingRevisionCapabilitiesInTransaction(
					tx,
					readReceiving,
				);
			const epoch = await prepareRuntimeReaderTrafficEpochInTransaction(
				tx,
				READER_TARGET,
				readReceiving,
			);
			return settle({ reconciled, epoch }, commit);
		});

		heading("Prepared");
		reportCompatibility(outcome.reconciled.compatibility);
		console.log(
			`  epoch       v${outcome.epoch.targetVersion} since ${outcome.epoch.continuousTrafficSince.toISOString()}`,
		);
		console.log(
			`  raise legal ${new Date(
				outcome.epoch.continuousTrafficSince.getTime() + EPOCH_SECONDS * 1_000,
			).toISOString()} (${seconds(EPOCH_SECONDS)} of uninterrupted compatible traffic)`,
		);
	}, options);
}

async function raisePhase(options: ControllerOptions): Promise<void> {
	await underCutoverSession(async (session, commit) => {
		const raised = await session.transaction().execute(async (tx) => {
			await raiseMinimumStreamReceiverVersionInTransaction(tx, RECEIVER_TARGET);
			const state = await raiseMinimumRuntimeReaderVersionInTransaction(
				tx,
				READER_TARGET,
			);
			return settle(state, commit);
		});

		heading("Floors raised");
		reportCompatibility(raised);
		console.log(
			`  enable legal ${new Date(
				raised.updatedAt.getTime() + STREAM_LEASE_TTL_SECONDS * 1_000,
			).toISOString()} (${seconds(STREAM_LEASE_TTL_SECONDS)} drain: the request cap plus stream grace)`,
		);
	}, options);
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
	await reportRevisions(readReceiving);

	heading("Audit scans");
	await runAuditScans(options.prod === true);

	await underCutoverSession(async (session, commit) => {
		const state = await session.transaction().execute(async (tx) => {
			const revisions = await readReceiving();
			const incompatible = revisions.filter(
				(revision) => revision.runtimeReaderVersion < READER_TARGET,
			);
			if (incompatible.length > 0) {
				throw new Error(
					`These revisions cannot serve reader v${READER_TARGET}: ${incompatible
						.map((revision) => revision.revision)
						.join(", ")}`,
				);
			}
			return settle(
				await enableLookupReferenceActivationInTransaction(
					tx,
					ACTIVATION_SWITCHES,
				),
				commit,
			);
		});

		heading("Activated");
		reportCompatibility(state);
	}, options);
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
			"current. Writing phases need an identity that may mutate control",
			"tables — the runtime service account is read-only there.",
			"",
			"Examples:",
			"  $ npx tsx scripts/rollout/activate-lookup-references.ts --prod",
			"  $ npx tsx scripts/rollout/activate-lookup-references.ts --prod --phase prepare --execute",
			"",
		].join("\n"),
	);
program.parse();
const options = program.opts<ControllerOptions>();
if (options.prod === true) targetProdDb();

runMain(async () => {
	const readReceiving = readCloudRunCapabilities({
		service: options.service,
		region: options.region,
	});
	try {
		if (options.phase === "status") await statusPhase(readReceiving);
		else if (options.phase === "prepare")
			await preparePhase(options, readReceiving);
		else if (options.phase === "raise") await raisePhase(options);
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
