/**
 * Designs in progress — the app list's second section (§15.9).
 *
 * A chat build no longer creates an app up front, so between the first turn
 * and the first committed workflow the user's work lives ONLY in a
 * `design_sessions` row. Without this listing that work is unreachable: there
 * is no app card to click and no URL to remember. These are deliberately NOT
 * app cards — nothing here is an app yet.
 *
 * Scope: the caller's OWN active pre-app build sessions in the Project they
 * are looking at. A design session's run holder, reservation, and transcript
 * all belong to the person who started it, and only that person can resume or
 * discard it, so an unrelated member seeing the row would only be able to look
 * at it. Membership in the Project is proved first and a denial returns an
 * empty list — the same opaque posture the app list takes.
 *
 * The stage is NOT derived here. `deriveDesignBuildStage` folds the durable
 * session row and its orchestration head into the §15.2 vocabulary, and it is
 * authored once in `lib/agent/build/progress.ts` beside the orchestrator that
 * writes those events; restating the fold in the data layer is exactly how a
 * list starts disagreeing with the conversation it links to.
 */

import { sql } from "kysely";
import {
	type OrchestrationHead,
	readOrchestrationHead,
} from "@/lib/agent/build/orchestratorState";
import {
	type DesignBuildStage,
	deriveDesignBuildStage,
} from "@/lib/agent/build/progress";
import { userInProject } from "./appAccess";
import {
	type DesignSessionState,
	parsePersistedDesignSessionState,
} from "./designSessions";
import { getAppDb } from "./pg";
import type { DesignSessionLeaseRow } from "./runLiveness";

/** One row of the Designs-in-progress section (§15.9). */
export interface DesignInProgressSummary {
	readonly designSessionId: string;
	/** The most recent thread's summary, or the honest fallback when the
	 *  conversation has not earned a name yet. */
	readonly title: string;
	readonly projectId: string;
	readonly stage: DesignBuildStage;
	/** ISO 8601 — the later of the session's own last write and its
	 *  conversation's, because either one is real activity. */
	readonly lastActivityAt: string;
	readonly materializedAppId: string | null;
	readonly awaitingInput: boolean;
	/** Whether a fresh turn can pick this design up where it stopped. False
	 *  only for an orchestration that failed unrecoverably; the row still
	 *  lists, because discarding it is the remaining action. */
	readonly recoverable: boolean;
}

export const UNTITLED_DESIGN_TITLE = "Untitled design";

/** How many rows the section shows. Pre-app sessions are short-lived and one
 *  actor can hold only one live build, so this binds only when someone has
 *  abandoned a long tail of them. */
const DEFAULT_LIMIT = 20;

/** Cheap empty-state probe using the same ownership/scope as the list. */
export async function userHasDesignsInProgress(args: {
	userId: string;
	projectId: string;
}): Promise<boolean> {
	if (!(await userInProject(args.userId, args.projectId, "view"))) return false;
	const db = await getAppDb();
	const row = await db
		.selectFrom("design_sessions")
		.select("id")
		.where("mode", "=", "build")
		.where("state", "=", "active")
		.where("app_id", "is", null)
		.where("owner_user_id", "=", args.userId)
		.where("project_id", "=", args.projectId)
		.limit(1)
		.executeTakeFirst();
	return row !== undefined;
}

/** The persisted shape the projection reads — spelled out so the pure
 *  projection below can be exercised without a database. It carries the full
 *  lease row because the stage fold's dead-run evidence includes a lapsed
 *  holder, derived through the one sanctioned liveness reader. */
export interface DesignInProgressRow extends DesignSessionLeaseRow {
	readonly id: string;
	readonly project_id: string;
	readonly app_id: string | null;
	readonly state: DesignSessionState;
	readonly last_error_type: string | null;
	/** The most recent thread bound to this session, when it has one. */
	readonly thread_summary: string | null;
	readonly thread_updated_at: string | null;
}

/**
 * Fold one session row plus its orchestration head into a list entry. Pure,
 * so the title fallback, the activity clock, and the recoverable rule are
 * testable without Postgres.
 */
export function projectDesignInProgress(
	row: DesignInProgressRow,
	head: OrchestrationHead | null,
): DesignInProgressSummary {
	const title = row.thread_summary?.trim();
	const threadActivity =
		row.thread_updated_at === null ? null : new Date(row.thread_updated_at);
	const lastActivity =
		threadActivity !== null && threadActivity > row.updated_at
			? threadActivity
			: row.updated_at;
	return {
		designSessionId: row.id,
		title: title && title.length > 0 ? title : UNTITLED_DESIGN_TITLE,
		projectId: row.project_id,
		stage: deriveDesignBuildStage(row, head),
		lastActivityAt: lastActivity.toISOString(),
		materializedAppId: row.app_id,
		awaitingInput: row.awaiting_input,
		recoverable: head?.state.kind === "failed" ? head.state.recoverable : true,
	};
}

/**
 * List the caller's active pre-app designs in one Project, most recent
 * activity first. A caller without membership gets an empty list rather than
 * a refusal, so probing another Project's id says nothing.
 */
export async function listDesignsInProgress(args: {
	userId: string;
	projectId: string;
	limit?: number;
}): Promise<DesignInProgressSummary[]> {
	if (!(await userInProject(args.userId, args.projectId, "view"))) return [];
	const db = await getAppDb();
	const rows = await db
		.selectFrom("design_sessions")
		.select([
			"id",
			"project_id",
			"app_id",
			"state",
			"awaiting_input",
			"owner_user_id",
			"run_id",
			"run_holder_nonce",
			"run_actor_user_id",
			"run_mode",
			"run_lease_expires_at",
			"res_period",
			"res_reserved",
			"res_settled",
			"res_user_id",
			"res_run_id",
			"last_error_type",
			"updated_at",
		])
		.where("mode", "=", "build")
		.where("state", "=", "active")
		/* Pre-app only: a materialized session resolves to its app and leaves
		 * this list rather than becoming a duplicate app card (§15.9). */
		.where("app_id", "is", null)
		.where("owner_user_id", "=", args.userId)
		.where("project_id", "=", args.projectId)
		/* Order and cut by the SAME clock the row displays: the later of the
		 * session's own last write and its newest conversation's. A write that
		 * stamps only the thread (a bailed-history merge) must not sort the
		 * design stale or push it off the LIMIT while its card shows fresh
		 * activity. `threads.updated_at` is server-written ISO-8601 TEXT, so
		 * its max is cast for the comparison. */
		.orderBy(
			sql`GREATEST(design_sessions.updated_at, COALESCE((
				SELECT max(threads.updated_at)
				FROM threads
				WHERE threads.design_session_id = design_sessions.id
			)::timestamptz, design_sessions.updated_at))`,
			"desc",
		)
		.orderBy("id", "asc")
		.limit(args.limit ?? DEFAULT_LIMIT)
		.execute();
	if (rows.length === 0) return [];

	const sessionIds = rows.map((row) => row.id);
	const threads = await db
		.selectFrom("threads")
		.select(["design_session_id", "summary", "updated_at"])
		.where("design_session_id", "in", sessionIds)
		/* One row per session: the conversation that was active last names the
		 * design, matching what resuming it opens into. */
		.distinctOn("design_session_id")
		.orderBy("design_session_id")
		.orderBy("updated_at", "desc")
		.orderBy("thread_id", "asc")
		.execute();
	const titles = new Map(
		threads.map((thread) => [
			thread.design_session_id as string,
			{ summary: thread.summary, updatedAt: thread.updated_at },
		]),
	);

	/* The head fold is one read per session. The list is bounded and a person
	 * holds a handful of these at most, so the round trips are cheap next to
	 * restating the chain fold with a join. */
	const heads = await Promise.all(
		sessionIds.map((id) => readOrchestrationHead(id)),
	);

	return rows.map((row, index) => {
		const thread = titles.get(row.id);
		return projectDesignInProgress(
			{
				...row,
				state: parsePersistedDesignSessionState(row.state),
				thread_summary: thread?.summary ?? null,
				thread_updated_at: thread?.updatedAt ?? null,
			},
			heads[index] ?? null,
		);
	});
}
