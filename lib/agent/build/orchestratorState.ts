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
import { z } from "zod";
import { designIdSchema } from "@/lib/agent/design/ids";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { acceptSettledPartialBuildInTransaction } from "@/lib/db/apps";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
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
			kind: z.literal("reviewing-candidate"),
			designSessionId: z.string().uuid(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("revising-candidate"),
			designSessionId: z.string().uuid(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("publishing-candidate"),
			designSessionId: z.string().uuid(),
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
			kind: z.literal("finished"),
			appId: z.string().min(1),
			appSeq: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			/** A human accepted the exact materialized app sequence after an
			 * interrupted initial build. The accepted canonical state is durable;
			 * uncommitted plan slices remain design history rather than silently
			 * pretending they were built. */
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

export class PartialBuildAcceptanceError extends Error {
	readonly name = "PartialBuildAcceptanceError";
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
	/* Write-side admission: the fold strict-parses every stored payload, so a
	 * state the schema rejects must fail HERE — before persistence — rather
	 * than becoming a poisoned event that bricks every later read of this
	 * session's chain (the head fold, the resume page, the designs list). */
	const state = buildOrchestratorStateSchema.parse(args.state);
	const revision = (args.expectedHead?.revision ?? 0) + 1;
	const eventId = crypto.randomUUID();
	const digest = orchestrationEventDigest({
		designSessionId: args.designSessionId,
		revision,
		eventId,
		predecessorEventId: args.expectedHead?.eventId ?? null,
		state,
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
			await tx
				.insertInto("design_orchestration_events")
				.values({
					design_session_id: args.designSessionId,
					revision,
					event_id: eventId,
					predecessor_event_id: args.expectedHead?.eventId ?? null,
					predecessor_digest: args.expectedHead?.digest ?? null,
					run_id: args.runId,
					holder_nonce_digest: holderNonceDigest(args.holderNonce),
					kind: state.kind,
					payload: JSON.stringify(state),
				})
				.execute();
		});
	} catch (err) {
		if ((err as { code?: unknown })?.code === "23505") {
			const winner = await readOrchestrationHead(args.designSessionId);
			if (
				winner?.revision === revision &&
				canonicalJsonDigest(winner.state) === canonicalJsonDigest(state)
			) {
				return winner;
			}
			throw new OrchestrationForkError();
		}
		throw err;
	}
	return { revision, eventId, digest, state };
}

/**
 * Finish an interrupted materialized build at the exact canonical sequence
 * that exists now. This is a human terminal transition, not a synthetic
 * successful executor run: the app row and orchestration event commit
 * together after current Project membership and the settled failed-run state
 * are re-proved under locks.
 */
export async function acceptPartialMaterializedBuild(args: {
	readonly designSessionId: string;
	readonly actorUserId: string;
}): Promise<{ appId: string; appSeq: number }> {
	const expectedHead = await readOrchestrationHead(args.designSessionId);
	if (expectedHead === null) {
		throw new PartialBuildAcceptanceError(
			"This build has no durable progress to accept.",
		);
	}

	return await withAppTx(async (tx) => {
		/* Resolve the mapping, then take the ordinary existing-app lock order:
		 * app first, Project membership, and finally the materialized session.
		 * The final locked re-read proves the optimistic mapping did not move. */
		const mapping = await tx
			.selectFrom("design_sessions")
			.select(["app_id"])
			.where("id", "=", args.designSessionId)
			.executeTakeFirst();
		if (mapping?.app_id === null || mapping?.app_id === undefined) {
			throw new PartialBuildAcceptanceError(
				"This design does not have a recoverable app yet.",
			);
		}

		const app = await tx
			.selectFrom("apps")
			.select([
				"project_id",
				"mutation_seq",
				"status",
				"res_settled",
				"deleted_at",
			])
			.where("id", "=", mapping.app_id)
			.forUpdate()
			.executeTakeFirst();
		if (app === undefined || app.deleted_at !== null) {
			throw new PartialBuildAcceptanceError(
				"This build is no longer available.",
			);
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			app.project_id,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new PartialBuildAcceptanceError(
				"You no longer have permission to finish this build.",
			);
		}
		const session = await tx
			.selectFrom("design_sessions")
			.select(["project_id", "app_id", "state"])
			.where("id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirst();
		if (
			session === undefined ||
			session.state !== "materialized" ||
			session.app_id !== mapping.app_id ||
			session.project_id !== app.project_id
		) {
			throw new PartialBuildAcceptanceError(
				"This build is no longer available.",
			);
		}
		const appSeq = safePersistedSequence(
			app.mutation_seq,
			`apps.mutation_seq for partial build ${session.app_id}`,
		);
		if (
			expectedHead.state.kind === "accepted-partial" &&
			expectedHead.state.appId === session.app_id &&
			app.status === "complete"
		) {
			return { appId: session.app_id, appSeq };
		}
		if (app.status !== "error" || app.res_settled !== true) {
			throw new PartialBuildAcceptanceError(
				"This build is still running or has not finished settling yet.",
			);
		}

		const latest = await tx
			.selectFrom("design_orchestration_events")
			.select(["revision", "event_id"])
			.where("design_session_id", "=", args.designSessionId)
			.orderBy("revision", "desc")
			.limit(1)
			.executeTakeFirst();
		if (
			latest === undefined ||
			safePersistedSequence(
				latest.revision,
				`design_orchestration_events.revision for session ${args.designSessionId}`,
			) !== expectedHead.revision ||
			latest.event_id !== expectedHead.eventId
		) {
			throw new OrchestrationForkError();
		}

		const state = buildOrchestratorStateSchema.parse({
			kind: "accepted-partial",
			appId: session.app_id,
			appSeq,
		});
		const revision = expectedHead.revision + 1;
		const eventId = crypto.randomUUID();
		const accepted = await acceptSettledPartialBuildInTransaction(tx, {
			appId: session.app_id,
			appSeq,
		});
		if (!accepted) {
			throw new PartialBuildAcceptanceError(
				"This build changed before it could be finished.",
			);
		}
		await tx
			.insertInto("design_orchestration_events")
			.values({
				design_session_id: args.designSessionId,
				revision,
				event_id: eventId,
				predecessor_event_id: expectedHead.eventId,
				predecessor_digest: expectedHead.digest,
				run_id: `partial:${eventId}`,
				holder_nonce_digest: holderNonceDigest(
					`partial:${args.actorUserId}:${eventId}`,
				),
				kind: state.kind,
				payload: JSON.stringify(state),
			})
			.execute();
		return { appId: session.app_id, appSeq };
	});
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
