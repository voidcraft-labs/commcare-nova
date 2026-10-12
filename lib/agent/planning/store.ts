import "server-only";
import { createHash } from "node:crypto";
import type { Transaction } from "kysely";
import { rehydrateModelMessage } from "@/lib/agent/modelMessagePersistence";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	assertDesignSessionRunAuthorityInTransaction,
	loadDesignSession,
} from "@/lib/db/designSessions";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	type AppPlan,
	editPlanText,
	PlanConflictError,
	type PlanEditor,
	planMarkdownSchema,
} from "./plan";

export interface PlanningAuthority {
	readonly sessionId: string;
	readonly actorUserId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly holderNonce: string;
}

export type PlanWriter =
	| { readonly editor: "architect" }
	| { readonly editor: "peer"; readonly reviewId: string };

/** All writers share the existing session/app lease and Project lock order. */
async function lockPlan(
	tx: Transaction<AppDatabase>,
	authority: PlanningAuthority,
) {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId: authority.sessionId,
		actorUserId: authority.actorUserId,
		expectedProjectId: authority.projectId,
		holder: {
			mode: "build",
			runId: authority.runId,
			nonce: authority.holderNonce,
		},
	});
	await tx
		.insertInto("authoring_plans")
		.values({ session_id: authority.sessionId })
		.onConflict((conflict) => conflict.column("session_id").doNothing())
		.execute();
	return tx
		.selectFrom("authoring_plans")
		.selectAll()
		.where("session_id", "=", authority.sessionId)
		.forUpdate()
		.executeTakeFirstOrThrow();
}

async function currentPlan(
	tx: DbReader,
	sessionId: string,
): Promise<AppPlan | null> {
	const row = await tx
		.selectFrom("authoring_plans as head")
		.innerJoin("authoring_plan_revisions as revision", (join) =>
			join
				.onRef("revision.session_id", "=", "head.session_id")
				.onRef("revision.revision", "=", "head.revision"),
		)
		.select([
			"head.session_id",
			"head.revision",
			"head.reviewed_revision",
			"revision.markdown",
			"revision.editor",
		])
		.where("head.session_id", "=", sessionId)
		.executeTakeFirst();
	if (!row) return null;
	if (
		row.editor !== "architect" &&
		row.editor !== "peer" &&
		row.editor !== "migration"
	)
		throw new Error("Unknown plan editor.");
	return {
		sessionId: row.session_id,
		revision: safePersistedSequence(row.revision, "plan revision"),
		markdown: row.markdown,
		editor: row.editor,
		reviewedRevision:
			row.reviewed_revision === null
				? null
				: safePersistedSequence(
						row.reviewed_revision,
						"reviewed plan revision",
					),
	};
}

type DbReader = Awaited<ReturnType<typeof getAppDb>> | Transaction<AppDatabase>;

export async function readAppPlan(args: {
	sessionId: string;
	actorUserId: string;
	projectId: string;
}): Promise<AppPlan | null> {
	const session = await loadDesignSession(args.sessionId);
	if (
		!session ||
		session.state === "retired" ||
		session.project_id !== args.projectId
	)
		throw new PlanConflictError("This plan is unavailable.");
	if (session.app_id) {
		const scope = await resolveAppScope(
			session.app_id,
			args.actorUserId,
			"view",
		);
		if (scope.projectId !== args.projectId)
			throw new PlanConflictError("The app has moved to another Project.");
	} else if (!(await projectRoleFor(args.actorUserId, args.projectId)))
		throw new PlanConflictError("Project access is no longer available.");
	return currentPlan(await getAppDb(), args.sessionId);
}

function assertWriter(reviewId: string | null, writer: PlanWriter) {
	if (
		writer.editor === "peer" ? reviewId !== writer.reviewId : reviewId !== null
	)
		throw new PlanConflictError(
			"The plan is being reviewed. Its current editor must finish before another editor can change it.",
		);
}

export async function writeAppPlan(args: {
	authority: PlanningAuthority;
	writer: PlanWriter;
	requestId: string;
	expectedRevision?: number;
	change: { markdown: string } | { oldText: string; newText: string };
}): Promise<AppPlan> {
	const requestDigest = canonicalJsonDigest({
		expectedRevision: args.expectedRevision,
		change: args.change,
		writer: args.writer,
	});
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, args.authority);
		const replay = await tx
			.selectFrom("authoring_plan_revisions")
			.select(["revision", "request_digest", "markdown", "editor"])
			.where("session_id", "=", args.authority.sessionId)
			.where("request_id", "=", args.requestId)
			.executeTakeFirst();
		if (replay) {
			if (replay.request_digest !== requestDigest)
				throw new PlanConflictError(
					"This plan edit was already used for different content.",
				);
			return {
				sessionId: args.authority.sessionId,
				revision: safePersistedSequence(replay.revision, "plan revision"),
				markdown: replay.markdown,
				editor: replay.editor as PlanEditor,
				reviewedRevision:
					head.reviewed_revision === null
						? null
						: safePersistedSequence(
								head.reviewed_revision,
								"reviewed plan revision",
							),
			};
		}
		assertWriter(head.review_complete ? null : head.review_id, args.writer);
		const revision = safePersistedSequence(head.revision, "plan revision");
		if (
			args.expectedRevision !== undefined &&
			revision !== args.expectedRevision
		)
			throw new PlanConflictError(
				`The plan is now revision ${revision}. Read it before editing.`,
			);
		const previous = await currentPlan(tx, args.authority.sessionId);
		const markdown =
			"markdown" in args.change
				? planMarkdownSchema.parse(args.change.markdown)
				: editPlanText(
						previous?.markdown ?? "",
						args.change.oldText,
						args.change.newText,
					);
		const next = revision + 1;
		await tx
			.insertInto("authoring_plan_revisions")
			.values({
				session_id: args.authority.sessionId,
				revision: next,
				markdown,
				editor: args.writer.editor,
				run_id: args.authority.runId,
				request_id: args.requestId,
				request_digest: requestDigest,
			})
			.execute();
		await tx
			.updateTable("authoring_plans")
			.set({ revision: next })
			.where("session_id", "=", args.authority.sessionId)
			.execute();
		await tx
			.updateTable("authoring_workspaces")
			.set({ plan_revision: next, updated_at: new Date() })
			.where("design_session_id", "=", args.authority.sessionId)
			.where("status", "=", "open")
			.execute();
		return {
			sessionId: args.authority.sessionId,
			revision: next,
			markdown,
			editor: args.writer.editor,
			reviewedRevision:
				head.reviewed_revision === null
					? null
					: safePersistedSequence(
							head.reviewed_revision,
							"reviewed plan revision",
						),
		};
	});
}

function reviewIdentity(sessionId: string, requestId: string) {
	const digest = createHash("sha256")
		.update(`${sessionId}:${requestId}`)
		.digest("hex");
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function planAtRevision(
	tx: DbReader,
	sessionId: string,
	revision: number,
): Promise<AppPlan> {
	const row = await tx
		.selectFrom("authoring_plan_revisions")
		.select(["markdown", "editor"])
		.where("session_id", "=", sessionId)
		.where("revision", "=", revision)
		.executeTakeFirstOrThrow();
	return {
		sessionId,
		revision,
		markdown: row.markdown,
		editor: row.editor as PlanEditor,
		reviewedRevision: revision,
	};
}

/** Recover only from immutable response/start pairs; current holder and time
 * are deliberately not evidence of the user turn that requested a review. */
async function originalReviewTurn(
	tx: DbReader,
	sessionId: string,
	requestId: string,
): Promise<string | null> {
	const rows = await tx
		.selectFrom("design_model_context_items as item")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"item.context_id",
		)
		.innerJoin("design_model_steps as completed", (join) =>
			join
				.onRef("completed.context_id", "=", "item.context_id")
				.onRef("completed.response_append_key", "=", "item.append_key")
				.on("completed.event_kind", "=", "completed"),
		)
		.innerJoin("design_model_steps as started", (join) =>
			join
				.onRef("started.context_id", "=", "completed.context_id")
				.onRef("started.step_key", "=", "completed.step_key")
				.on("started.event_kind", "=", "started"),
		)
		.select(["item.message", "item.item_digest", "started.turn_provenance_id"])
		.where("context.design_session_id", "=", sessionId)
		.where("context.context_kind", "=", "architect")
		.execute();
	const turns = new Set<string>();
	for (const row of rows) {
		if (!row.turn_provenance_id) continue;
		if (canonicalJsonDigest(row.message) !== row.item_digest)
			throw new PlanConflictError(
				"The original review response no longer matches its retained evidence.",
			);
		const message = rehydrateModelMessage(row.message);
		if (message.role !== "assistant") continue;
		const callId = requestId.endsWith(":plan")
			? requestId.slice(0, -5)
			: requestId;
		const matchingCall =
			Array.isArray(message.content) &&
			message.content.some(
				(part) => part.type === "tool-call" && part.toolCallId === callId,
			);
		const matchingFinish = ["app", "planning"].some((kind) =>
			requestId.startsWith(`${kind}-finish:${row.turn_provenance_id}:`),
		);
		if (matchingCall || matchingFinish) turns.add(row.turn_provenance_id);
	}
	return turns.size === 1 ? [...turns][0] : null;
}

export async function pausePlanReview(
	authority: PlanningAuthority,
	reviewId: string,
	checkpoint: { contextId: string; summary: string; summaryAvailable: boolean },
) {
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, authority);
		const review = await tx
			.selectFrom("authoring_reviews")
			.selectAll()
			.where("id", "=", reviewId)
			.where("session_id", "=", authority.sessionId)
			.executeTakeFirstOrThrow();
		if (review.paused_at !== null) return review;
		if (
			head.review_id !== reviewId ||
			head.review_complete ||
			review.completed_revision !== null
		)
			throw new PlanConflictError("This review no longer owns the plan.");
		const context = await tx
			.selectFrom("design_model_contexts")
			.select(["design_session_id", "context_kind", "context_version"])
			.where("id", "=", checkpoint.contextId)
			.executeTakeFirstOrThrow();
		if (
			context.design_session_id !== authority.sessionId ||
			context.context_kind !== "peer" ||
			context.context_version !== reviewId
		)
			throw new PlanConflictError("The checkpoint belongs to another review.");
		const issuing =
			review.issuing_turn_id ??
			(await originalReviewTurn(tx, authority.sessionId, review.request_id));
		return tx
			.updateTable("authoring_reviews")
			.set({
				paused_at: new Date(),
				checkpoint_summary: checkpoint.summary,
				checkpoint_context_id: checkpoint.contextId,
				summary_available: checkpoint.summaryAvailable,
				...(issuing && { issuing_turn_id: issuing }),
			})
			.where("id", "=", reviewId)
			.returningAll()
			.executeTakeFirstOrThrow();
	});
}

/** The review records which source and app the peer actually saw. Its prose
 * stays prose; only ownership, revisions and completion are database facts. */
export async function beginPlanReview(
	authority: PlanningAuthority,
	requestId: string,
	snapshot: {
		sourceDigest: string;
		appSeq: number | null;
		focus?: string;
		issuingTurnId?: string;
	} | null = null,
) {
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, authority);
		const plan = await currentPlan(tx, authority.sessionId);
		if (!plan)
			throw new PlanConflictError("Write the plan before asking for review.");
		let id = reviewIdentity(authority.sessionId, requestId);
		let predecessor: string | null = null;
		let effectiveRequestId = requestId;
		let prior = await tx
			.selectFrom("authoring_reviews")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		while (prior) {
			const successor = await tx
				.selectFrom("authoring_reviews")
				.selectAll()
				.where("predecessor_review_id", "=", prior.id)
				.executeTakeFirst();
			if (successor) {
				prior = successor;
				continue;
			}
			if (prior.paused_at !== null && snapshot?.issuingTurnId) {
				const issuing =
					prior.issuing_turn_id ??
					(await originalReviewTurn(tx, authority.sessionId, prior.request_id));
				if (!issuing)
					throw new PlanConflictError(
						"The unfinished review has no verifiable original user turn. Its evidence is preserved; this review needs an explicit provenance repair before it can continue.",
					);
				if (issuing !== snapshot.issuingTurnId) {
					if (head.review_id !== prior.id || head.review_complete)
						throw new PlanConflictError(
							"This unfinished review no longer owns the plan.",
						);
					predecessor = prior.id;
					effectiveRequestId = `continue:${prior.id}:${snapshot.issuingTurnId}`;
					id = reviewIdentity(authority.sessionId, effectiveRequestId);
					break;
				}
			}
			const receiptPlan =
				prior.completed_revision === null
					? plan
					: await planAtRevision(
							tx,
							authority.sessionId,
							Number(prior.completed_revision),
						);
			return {
				reviewId: prior.id,
				plan: receiptPlan,
				complete: prior.completed_revision !== null,
				review: prior,
			};
		}
		if (!predecessor && head.review_id && !head.review_complete)
			throw new PlanConflictError("A peer is already reviewing this plan.");
		if (snapshot?.appSeq !== null && snapshot?.appSeq !== undefined) {
			const session = await tx
				.selectFrom("design_sessions")
				.select("app_id")
				.where("id", "=", authority.sessionId)
				.executeTakeFirstOrThrow();
			if (!session.app_id)
				throw new PlanConflictError("There is no app to review yet.");
			const app = await tx
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", session.app_id)
				.executeTakeFirstOrThrow();
			if (
				safePersistedSequence(app.mutation_seq, "app sequence") !==
				snapshot.appSeq
			)
				throw new PlanConflictError("The app changed before its review began.");
		}
		const review = await tx
			.insertInto("authoring_reviews")
			.values({
				id,
				session_id: authority.sessionId,
				request_id: effectiveRequestId,
				issuing_turn_id: snapshot?.issuingTurnId
					? predecessor
						? snapshot.issuingTurnId
						: ((await originalReviewTurn(tx, authority.sessionId, requestId)) ??
							snapshot.issuingTurnId)
					: null,
				predecessor_review_id: predecessor,
				plan_revision: plan.revision,
				source_digest: snapshot?.sourceDigest ?? null,
				app_seq: snapshot?.appSeq ?? null,
				focus: snapshot?.focus ?? null,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
		await tx
			.updateTable("authoring_plans")
			.set({ review_id: id, review_complete: false })
			.where("session_id", "=", authority.sessionId)
			.execute();
		return { reviewId: id, plan, complete: false, review };
	});
}

export async function finishPlanReview(
	authority: PlanningAuthority,
	reviewId: string,
	completion?: { contextId: string; summary: string; sourceDigest?: string },
): Promise<AppPlan> {
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, authority);
		const review = await tx
			.selectFrom("authoring_reviews")
			.selectAll()
			.where("id", "=", reviewId)
			.where("session_id", "=", authority.sessionId)
			.executeTakeFirstOrThrow();
		if (review.paused_at !== null)
			throw new PlanConflictError(
				"An unfinished checkpoint cannot complete a review.",
			);
		if (review.completed_revision === null) {
			if (head.review_id !== reviewId)
				throw new PlanConflictError("This review no longer owns the plan.");
			if (completion) {
				const context = await tx
					.selectFrom("design_model_contexts")
					.select(["context_kind", "context_version", "design_session_id"])
					.where("id", "=", completion.contextId)
					.executeTakeFirstOrThrow();
				if (
					context.context_kind !== "peer" ||
					context.context_version !== reviewId ||
					context.design_session_id !== authority.sessionId
				)
					throw new PlanConflictError(
						"The response belongs to another review.",
					);
			}
			const revision = safePersistedSequence(
				head.revision,
				"reviewed plan revision",
			);
			await tx
				.updateTable("authoring_reviews")
				.set({
					completed_revision: revision,
					...(completion && {
						context_id: completion.contextId,
						summary: completion.summary,
						...(completion.sourceDigest && {
							source_digest: completion.sourceDigest,
						}),
					}),
				})
				.where("id", "=", reviewId)
				.execute();
			await tx
				.updateTable("authoring_plans")
				.set({ review_complete: true, reviewed_revision: revision })
				.where("session_id", "=", authority.sessionId)
				.execute();
		}
		const plan = await currentPlan(tx, authority.sessionId);
		if (!plan) throw new Error("The reviewed plan is missing.");
		return plan;
	});
}

export async function activePlanReview(authority: PlanningAuthority) {
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, authority);
		if (!head.review_id || head.review_complete) return null;
		return tx
			.selectFrom("authoring_reviews")
			.selectAll()
			.where("id", "=", head.review_id)
			.executeTakeFirstOrThrow();
	});
}

export async function latestPlanReview(
	authority: PlanningAuthority,
	sourceDigest: string,
	appSeq: number | null,
) {
	return withAppTx(async (tx) => {
		const head = await lockPlan(tx, authority);
		return tx
			.selectFrom("authoring_reviews")
			.selectAll()
			.where("session_id", "=", authority.sessionId)
			.where("source_digest", "=", sourceDigest)
			.where("app_seq", appSeq === null ? "is" : "=", appSeq)
			.where("completed_revision", "=", head.revision)
			.where("context_id", "is not", null)
			.orderBy("created_at", "desc")
			.executeTakeFirst();
	});
}

/** Caller holds the session/app authority before taking this lock. */
