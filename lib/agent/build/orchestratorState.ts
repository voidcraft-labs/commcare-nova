/**
 * Durable orchestrator state — the append-only transition chain and its
 * strict fold (§13.2).
 *
 * The control state of one build orchestration is never inferred from the
 * chat transcript or held in an editable blob: every transition appends one
 * `design_orchestration_events` row naming its predecessor by id AND digest,
 * and the CURRENT state is the strict fold of the whole chain — contiguity,
 * predecessor identity, and per-kind payload all re-proved on every read.
 * The partial unique index on `(design_session_id, predecessor_event_id)`
 * makes two continuations structurally unable to advance the same state
 * (`OrchestrationForkError`), which is both process-death recovery and the
 * structural detector for "a required phase was skipped".
 *
 * Raw holder nonces never land here — the row carries a SHA-256 digest for
 * audit correlation; the design-session/app row remains the only nonce
 * authority.
 */

import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import { z } from "zod";
import {
	ORCHESTRATION_KIND_CLASSIFICATION,
	type OrchestrationKindClass,
} from "@/lib/agent/build/orchestrationKinds";
import { designIdSchema } from "@/lib/agent/design/ids";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { completeAndSettleRunInTransaction } from "@/lib/db/apps";
import { RunHolderLostError } from "@/lib/db/commitGuard";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The closed state vocabulary one build orchestration moves through. Each
 * arm is exactly the payload its event row persists; the fold returns the
 * last arm. (`reviewing-implementation` joins with the conformance unit.)
 */
export const buildOrchestratorStateSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("designing"),
			designSessionId: z.string().uuid(),
			sourcePackageDigest: sha256Schema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("awaiting-user"),
			designSessionId: z.string().uuid(),
			/** The revision whose blocking open questions paused the build —
			 * the questions live ON the accepted revision, so the revision id
			 * is the question artifact's address. */
			designRevisionId: z.string().uuid(),
			blockingQuestionIds: z.array(designIdSchema).min(1),
		})
		.strict(),
	z
		.object({
			/** The design agent paused on its own askQuestions round. The
			 * questions live in the THREAD (the tool part the client renders),
			 * not on an artifact, and a round can precede any contract — so
			 * the arm carries the head revision only when one exists. */
			kind: z.literal("awaiting-user-questions"),
			designSessionId: z.string().uuid(),
			designRevisionId: z.string().uuid().nullable(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("planning"),
			designRevisionId: z.string().uuid(),
			designRevisionDigest: sha256Schema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("executing-slice"),
			designRevisionId: z.string().uuid(),
			buildPlanId: z.string().uuid(),
			sliceId: designIdSchema,
			changeSetId: z.string().uuid(),
			attempt: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("translating"),
			designRevisionId: z.string().uuid(),
			buildPlanId: z.string().uuid(),
			appId: z.string().min(1),
			sourceSeq: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("finished"),
			appId: z.string().min(1),
			appSeq: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			/** Historical persisted state from the retired partial-acceptance path.
			 * New orchestrations have no writer for this arm. */
			kind: z.literal("accepted-partial"),
			appId: z.string().min(1),
			appSeq: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("failed"),
			failureId: z.string().uuid(),
			recoverable: z.boolean(),
			errorType: z.string().min(1),
		})
		.strict(),
]);
export type BuildOrchestratorState = z.infer<
	typeof buildOrchestratorStateSchema
>;

/* Compile-time lockstep with `orchestrationKinds.ts`: the classification must
 * name every kind in this union, so adding an arm here without deciding
 * whether it releases the app freeze fails the build — the SQL gate, progress
 * fold, and interruption stamp all derive from that record. (The unit test
 * pins the reverse direction: no stale classified kind.) */
const _everyOrchestrationKindIsClassified =
	ORCHESTRATION_KIND_CLASSIFICATION satisfies Record<
		BuildOrchestratorState["kind"],
		OrchestrationKindClass
	>;

/** The fold's result — everything an append needs to name its predecessor. */
export interface OrchestrationHead {
	readonly revision: number;
	readonly eventId: string;
	readonly digest: string;
	readonly state: BuildOrchestratorState;
}

/** Two continuations tried to advance the same state — the loser's insert
 *  hit the predecessor/revision uniqueness. The loser re-reads the head and
 *  either adopts the winner's transition or stops. */
export class OrchestrationForkError extends Error {
	readonly name = "OrchestrationForkError";
	constructor() {
		super(
			"Another continuation of this build already advanced its orchestration state. Reload the current state before continuing.",
		);
	}
}

/** The canonical content digest of one event — what its successor pins as
 *  `predecessor_digest`. */
function orchestrationEventDigest(args: {
	designSessionId: string;
	revision: number;
	eventId: string;
	predecessorEventId: string | null;
	state: BuildOrchestratorState;
}): string {
	return canonicalJsonDigest({
		designSessionId: args.designSessionId,
		revision: args.revision,
		eventId: args.eventId,
		predecessorEventId: args.predecessorEventId,
		kind: args.state.kind,
		payload: args.state,
	});
}

function holderNonceDigest(holderNonce: string): string {
	return createHash("sha256").update(holderNonce).digest("hex");
}

interface PreparedOrchestrationEvent {
	readonly revision: number;
	readonly eventId: string;
	readonly digest: string;
	readonly state: BuildOrchestratorState;
}

function prepareOrchestrationEvent(args: {
	readonly designSessionId: string;
	readonly state: BuildOrchestratorState;
	readonly expectedHead: OrchestrationHead | null;
}): PreparedOrchestrationEvent {
	/* Write-side admission: the fold strict-parses every stored payload, so a
	 * state the schema rejects must fail HERE — before persistence — rather
	 * than becoming a poisoned event that bricks every later read. */
	const state = buildOrchestratorStateSchema.parse(args.state);
	const revision = (args.expectedHead?.revision ?? 0) + 1;
	const eventId = crypto.randomUUID();
	return {
		revision,
		eventId,
		state,
		digest: orchestrationEventDigest({
			designSessionId: args.designSessionId,
			revision,
			eventId,
			predecessorEventId: args.expectedHead?.eventId ?? null,
			state,
		}),
	};
}

async function insertPreparedOrchestrationEvent(
	tx: Transaction<AppDatabase>,
	args: {
		readonly designSessionId: string;
		readonly runId: string;
		readonly holderNonce: string;
		readonly expectedHead: OrchestrationHead | null;
	},
	prepared: PreparedOrchestrationEvent,
): Promise<void> {
	await tx
		.insertInto("design_orchestration_events")
		.values({
			design_session_id: args.designSessionId,
			revision: prepared.revision,
			event_id: prepared.eventId,
			predecessor_event_id: args.expectedHead?.eventId ?? null,
			predecessor_digest: args.expectedHead?.digest ?? null,
			run_id: args.runId,
			holder_nonce_digest: holderNonceDigest(args.holderNonce),
			kind: prepared.state.kind,
			payload: JSON.stringify(prepared.state),
		})
		.execute();
}

function preparedHead(prepared: PreparedOrchestrationEvent): OrchestrationHead {
	return {
		revision: prepared.revision,
		eventId: prepared.eventId,
		digest: prepared.digest,
		state: prepared.state,
	};
}

function winnerMatchesPrepared(
	winner: OrchestrationHead | null,
	prepared: PreparedOrchestrationEvent,
): winner is OrchestrationHead {
	return (
		winner?.revision === prepared.revision &&
		canonicalJsonDigest(winner.state) === canonicalJsonDigest(prepared.state)
	);
}

type CompletionCommitFaultHook = () => void | Promise<void>;
let completionCommitFaultHook: CompletionCommitFaultHook | null = null;

/** Deterministic lost-response seam. Production never installs it; tests use
 * it to throw after the terminal transaction commits but before its caller
 * receives the result. */
export function __setCompletionCommitFaultHookForTests(
	hook: CompletionCommitFaultHook | null,
): void {
	completionCommitFaultHook = hook;
}

/**
 * Append one transition. `expectedHead` is the fold the caller acted on
 * (`null` for the first event); a concurrent continuation that advanced the
 * chain first surfaces as `OrchestrationForkError`, never a silent
 * double-advance.
 */
export async function appendOrchestrationEvent(args: {
	readonly designSessionId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly actorUserId: string;
	readonly expectedProjectId: string;
	readonly state: BuildOrchestratorState;
	readonly expectedHead: OrchestrationHead | null;
}): Promise<OrchestrationHead> {
	const prepared = prepareOrchestrationEvent({
		designSessionId: args.designSessionId,
		state: args.state,
		expectedHead: args.expectedHead,
	});
	try {
		await withAppTx(async (tx) => {
			await assertDesignSessionRunAuthorityInTransaction(tx, {
				designSessionId: args.designSessionId,
				actorUserId: args.actorUserId,
				expectedProjectId: args.expectedProjectId,
				holder: {
					mode: "build",
					runId: args.runId,
					nonce: args.holderNonce,
				},
			});
			await insertPreparedOrchestrationEvent(tx, args, prepared);
		});
	} catch (err) {
		if ((err as { code?: unknown })?.code === "23505") {
			const winner = await readOrchestrationHead(args.designSessionId);
			if (winnerMatchesPrepared(winner, prepared)) return winner;
			throw new OrchestrationForkError();
		}
		throw err;
	}
	return preparedHead(prepared);
}

/**
 * Commit the terminal orchestration event, exact-sequence app completion, and
 * kept-charge settlement atomically. The holder is proved while still live;
 * no successful build can release its authority before recording `finished`,
 * and no terminal event can survive a failed completion CAS.
 */
export async function completeBuildOrchestration(args: {
	readonly designSessionId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly actorUserId: string;
	readonly expectedProjectId: string;
	readonly appId: string;
	readonly expectedSeq: number;
	readonly expectedHead: OrchestrationHead | null;
}): Promise<OrchestrationHead> {
	const prepared = prepareOrchestrationEvent({
		designSessionId: args.designSessionId,
		state: {
			kind: "finished",
			appId: args.appId,
			appSeq: args.expectedSeq,
		},
		expectedHead: args.expectedHead,
	});
	try {
		await withAppTx(async (tx) => {
			/* Lifecycle lock order remains actor gate -> app row. The delegated
			 * design-session authority proof then reuses that app-row lock. */
			await lockActorGenerationGateForAppHolder(tx, args.appId);
			const authority = await assertDesignSessionRunAuthorityInTransaction(tx, {
				designSessionId: args.designSessionId,
				actorUserId: args.actorUserId,
				expectedProjectId: args.expectedProjectId,
				holder: {
					mode: "build",
					runId: args.runId,
					nonce: args.holderNonce,
				},
				allowReapedBuildCompletion: true,
			});
			if (authority.appId !== args.appId) {
				throw new RunHolderLostError("released");
			}
			const completion = await completeAndSettleRunInTransaction(
				tx,
				args.appId,
				args.runId,
				args.holderNonce,
				args.expectedSeq,
			);
			if (completion !== "owned") throw new RunHolderLostError(completion);
			await insertPreparedOrchestrationEvent(tx, args, prepared);
		});
		await completionCommitFaultHook?.();
	} catch (err) {
		/* Every error after the transaction started has an unknown commit
		 * outcome from this process's perspective (not only a 23505 or a holder
		 * loss). Re-read the append-only head first: a matching terminal event
		 * proves the exact status/settlement transaction committed and is the
		 * authoritative response to adopt. */
		const winner = await readOrchestrationHead(args.designSessionId);
		if (winnerMatchesPrepared(winner, prepared)) return winner;
		if ((err as { code?: unknown })?.code === "23505") {
			throw new OrchestrationForkError();
		}
		throw err;
	}
	return preparedHead(prepared);
}

/**
 * The strict fold: read the COMPLETE chain, prove contiguity and every
 * predecessor id+digest, strict-parse every payload, and return the head.
 * `null` means no orchestration has started for this session.
 */
export async function readOrchestrationHead(
	designSessionId: string,
): Promise<OrchestrationHead | null> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_orchestration_events")
		.select(["revision", "event_id", "predecessor_event_id", "kind"])
		.select(["predecessor_digest"])
		.select((eb) =>
			eb.cast<string>(eb.ref("payload"), "text").as("payload_text"),
		)
		.where("design_session_id", "=", designSessionId)
		.orderBy("revision", "asc")
		.execute();
	if (rows.length === 0) return null;
	let head: OrchestrationHead | null = null;
	for (const [index, row] of rows.entries()) {
		const revision = safePersistedSequence(
			row.revision,
			`design_orchestration_events.revision for session ${designSessionId}`,
		);
		if (revision !== index + 1) {
			throw new Error(
				`Orchestration chain for design session ${designSessionId} is not contiguous: expected revision ${index + 1}, found ${revision}.`,
			);
		}
		if (row.predecessor_event_id !== (head?.eventId ?? null)) {
			throw new Error(
				`Orchestration event ${row.event_id} names predecessor ${row.predecessor_event_id ?? "none"}, but the chain's prior event is ${head?.eventId ?? "none"}.`,
			);
		}
		if (row.predecessor_digest !== (head?.digest ?? null)) {
			throw new Error(
				`Orchestration event ${row.event_id} pins predecessor digest ${row.predecessor_digest ?? "none"}, but the chain's prior event folds to ${head?.digest ?? "none"}.`,
			);
		}
		const state = buildOrchestratorStateSchema.parse(
			parsePersistedJsonText(
				row.payload_text,
				`design_orchestration_events.payload for session ${designSessionId}, revision ${revision}`,
			),
		);
		if (state.kind !== row.kind) {
			throw new Error(
				`Orchestration event ${row.event_id} is stored as kind ${row.kind} but its payload folds to ${state.kind}.`,
			);
		}
		const digest = orchestrationEventDigest({
			designSessionId,
			revision,
			eventId: row.event_id,
			predecessorEventId: row.predecessor_event_id,
			state,
		});
		head = { revision, eventId: row.event_id, digest, state };
	}
	return head;
}
