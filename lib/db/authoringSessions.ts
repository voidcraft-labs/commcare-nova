import "server-only";

import type { Transaction } from "kysely";
import { AuthoringInputError } from "@/lib/agent/authoring/errors";
import type { ChatRunHolderCapability } from "./apps";
import {
	assertProjectCapabilityInTransaction,
	lockAppRow,
} from "./canonicalCommitKernel";
import { RunHolderLostError } from "./commitGuard";
import { leaseView } from "./leaseView";
import type { AppDatabase } from "./pg";
import { exactRunHolderMatches } from "./runHolderWrites";
import { runLeaseState } from "./runLiveness";

export interface AuthoringSession {
	id: string;
	actorUserId: string;
	projectId: string;
	origin: "chat" | "mcp";
	threadId: string | null;
	appId: string | null;
	proposedAppId: string | null;
	appName: string;
	activeCandidateId: string | null;
}

export class AuthoringAuthorityError extends Error {
	constructor(
		message = "This private work is unavailable. Open work you own in this Project.",
	) {
		super(message);
		this.name = "AuthoringAuthorityError";
	}
}

/** App → session → membership is the same lock order used by publication.
 * Origin is authority, never a property that a caller can change on resume. */
export async function assertAuthoringSessionAuthorityInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		sessionId: string;
		actorUserId: string;
		expectedProjectId?: string;
		chatRunHolder?: ChatRunHolderCapability;
		origin?: "chat" | "mcp";
		threadId?: string;
		allowIdleChat?: boolean;
		requireIdleChat?: boolean;
	},
): Promise<AuthoringSession> {
	const mapping = await tx
		.selectFrom("authoring_sessions")
		.select(["app_id"])
		.where("id", "=", args.sessionId)
		.executeTakeFirst();
	if (!mapping) throw new AuthoringAuthorityError();
	const app = mapping.app_id ? await lockAppRow(tx, mapping.app_id) : null;
	const row = await tx
		.selectFrom("authoring_sessions")
		.selectAll()
		.where("id", "=", args.sessionId)
		.forUpdate()
		.executeTakeFirst();
	const origin = args.origin ?? (args.chatRunHolder ? "chat" : "mcp");
	if (
		!row ||
		row.actor_user_id !== args.actorUserId ||
		row.origin !== origin ||
		row.app_id !== mapping.app_id ||
		(args.expectedProjectId !== undefined &&
			row.project_id !== args.expectedProjectId) ||
		(mapping.app_id !== null &&
			(!app || app.deleted_at !== null || app.project_id !== row.project_id)) ||
		(origin === "chat" &&
			args.threadId !== undefined &&
			row.thread_id !== args.threadId)
	) {
		throw new AuthoringAuthorityError();
	}
	await assertProjectCapabilityInTransaction(
		tx,
		args.actorUserId,
		row.project_id,
		"edit",
		"You no longer have edit access to this work's Project.",
	);
	if (origin === "chat") {
		if (!app || !row.thread_id) throw new AuthoringAuthorityError();
		const thread = await tx
			.selectFrom("threads")
			.select(["app_id", "design_session_id", "run_id", "active_holder_nonce"])
			.where("thread_id", "=", row.thread_id)
			.executeTakeFirst();
		// A conversation born in design keeps its design-session identity after
		// app birth. Ordinary edit turns still own the bound canonical app.
		const boundDesign = thread?.design_session_id
			? await tx
					.selectFrom("design_sessions")
					.select("app_id")
					.where("id", "=", thread.design_session_id)
					.executeTakeFirst()
			: null;
		if (!thread || (thread.app_id ?? boundDesign?.app_id) !== row.app_id)
			throw new AuthoringAuthorityError();
		const lease = runLeaseState(leaseView(app));
		if (args.chatRunHolder) {
			if (
				args.chatRunHolder.mode !== "edit" ||
				!lease.live ||
				!exactRunHolderMatches(lease.holderIdentity, args.chatRunHolder) ||
				app.lock_actor_user_id !== args.actorUserId ||
				thread.run_id !== args.chatRunHolder.runId ||
				thread.active_holder_nonce !== args.chatRunHolder.nonce
			) {
				throw new RunHolderLostError();
			}
		} else if (!args.allowIdleChat) {
			throw new AuthoringAuthorityError(
				"Continue this conversation before changing its pending work.",
			);
		}
		if (args.requireIdleChat && lease.live) {
			throw new AuthoringAuthorityError(
				"Wait for the active run to finish before discarding its pending work.",
			);
		}
	}
	return {
		id: row.id,
		actorUserId: row.actor_user_id,
		projectId: row.project_id,
		origin,
		threadId: row.thread_id,
		appId: row.app_id,
		proposedAppId: row.proposed_app_id,
		appName: row.app_name,
		activeCandidateId: row.active_candidate_id,
	};
}

export type AuthoringRequestOwner =
	| { ordinarySessionId: string }
	| { designSessionId: string };

/** Caller holds and has freshly authorized the owner's authority row. These
 * functions deliberately do not infer permission from a stored receipt. */
export async function bindAuthoringRequestInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		owner: AuthoringRequestOwner;
		requestId: string;
		operation: string;
		inputDigest: string;
		candidateId: string | null;
	},
) {
	const column =
		"ordinarySessionId" in args.owner
			? "ordinary_session_id"
			: "design_session_id";
	const id =
		"ordinarySessionId" in args.owner
			? args.owner.ordinarySessionId
			: args.owner.designSessionId;
	const prior = await tx
		.selectFrom("authoring_session_requests")
		.selectAll()
		.where(column, "=", id)
		.where("request_id", "=", args.requestId)
		.executeTakeFirst();
	if (prior) {
		if (
			prior.operation !== args.operation ||
			prior.input_digest !== args.inputDigest
		)
			throw new AuthoringInputError(
				"This request identity was already used with different input.",
			);
		return prior;
	}
	return tx
		.insertInto("authoring_session_requests")
		.values({
			ordinary_session_id: "ordinarySessionId" in args.owner ? id : null,
			design_session_id: "designSessionId" in args.owner ? id : null,
			request_id: args.requestId,
			operation: args.operation,
			input_digest: args.inputDigest,
			candidate_id: args.candidateId,
			result_json: null,
		})
		.returningAll()
		.executeTakeFirstOrThrow();
}

export async function completeAuthoringRequestInTransaction(
	tx: Transaction<AppDatabase>,
	args: { owner: AuthoringRequestOwner; requestId: string; result: unknown },
) {
	const column =
		"ordinarySessionId" in args.owner
			? "ordinary_session_id"
			: "design_session_id";
	const id =
		"ordinarySessionId" in args.owner
			? args.owner.ordinarySessionId
			: args.owner.designSessionId;
	await tx
		.updateTable("authoring_session_requests")
		.set({ result_json: JSON.stringify(args.result) })
		.where(column, "=", id)
		.where("request_id", "=", args.requestId)
		.where("result_json", "is", null)
		.execute();
}
