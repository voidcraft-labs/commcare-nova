import { sql } from "kysely";
import { rehydrateModelMessage } from "@/lib/agent/modelMessagePersistence";
import { lockActorGenerationGate } from "@/lib/db/actorGenerationGate";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState } from "@/lib/db/runLiveness";
import { threadIdentityLockScope } from "@/lib/db/threads";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	findAuthoringAmplification,
	planAuthoringAmplificationRepair,
} from "./authoringAmplification";

function verifiedMessages(
	items: readonly { item_digest: string; message: unknown }[],
) {
	try {
		return items.map((item) => {
			if (canonicalJsonDigest(item.message) !== item.item_digest)
				throw new Error("Model item digest mismatch.");
			return rehydrateModelMessage(item.message);
		});
	} catch {
		// A corrupt or unsupported durable origin is reported, never repaired.
		return null;
	}
}

export async function inspectAuthoringAmplification(threadId: string) {
	const db = await getAppDb();
	const thread = await db
		.selectFrom("threads")
		.selectAll()
		.where("thread_id", "=", threadId)
		.executeTakeFirstOrThrow();
	if (!thread.design_session_id) return null;
	const candidate = findAuthoringAmplification(thread.messages);
	if (!candidate) return null;
	const session = await db
		.selectFrom("design_sessions")
		.selectAll()
		.where("id", "=", thread.design_session_id)
		.executeTakeFirstOrThrow();
	const items = await db
		.selectFrom("design_model_context_items as item")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"item.context_id",
		)
		.select([
			"item.context_id",
			"item.ordinal",
			"item.item_digest",
			"item.message",
		])
		.where("context.design_session_id", "=", session.id)
		.where("context.context_kind", "=", "architect")
		.orderBy("item.context_id")
		.orderBy("item.ordinal")
		.execute();
	const verified = planAuthoringAmplificationRepair(
		thread.messages,
		verifiedMessages(items) ?? [],
	);
	const plan = candidate;
	const guard = {
		session: JSON.parse(JSON.stringify(session)),
		thread: { ...thread, messages: undefined },
		durableDigest: canonicalJsonDigest(items),
	};
	return {
		threadId,
		sessionId: session.id,
		ownerUserId: session.owner_user_id,
		guardDigest: canonicalJsonDigest(guard),
		transcriptDigest: plan.beforeDigest,
		repairedDigest: plan.afterDigest,
		copies: plan.copies,
		removedParts: plan.removedParts,
		durableOriginVerified: verified !== null,
		repairable:
			verified !== null &&
			session.mode === "build" &&
			session.state === "active" &&
			session.app_id === null &&
			!designSessionLeaseState(session).live &&
			thread.active_stream_id === null,
		// Snapshot is intentionally private evidence; scanner output omits it.
		snapshot: { session, thread, items },
		plan,
	};
}

/** Exact scan evidence is required; this does not claim that app requirements are satisfied. */
export async function repairAuthoringAmplification(args: {
	threadId: string;
	guardDigest: string;
	transcriptDigest: string;
	apply: boolean;
}) {
	const before = await inspectAuthoringAmplification(args.threadId);
	if (!before)
		throw new Error("No unambiguous repeated final response was found.");
	return await withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, before.ownerUserId);
		const session = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("id", "=", before.sessionId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		await sql`SELECT pg_advisory_xact_lock(hashtextextended(${threadIdentityLockScope(args.threadId)}, 0::bigint))`.execute(
			tx,
		);
		const thread = await tx
			.selectFrom("threads")
			.selectAll()
			.where("thread_id", "=", args.threadId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const items = await tx
			.selectFrom("design_model_context_items as item")
			.innerJoin(
				"design_model_contexts as context",
				"context.id",
				"item.context_id",
			)
			.select([
				"item.context_id",
				"item.ordinal",
				"item.item_digest",
				"item.message",
			])
			.where("context.design_session_id", "=", session.id)
			.where("context.context_kind", "=", "architect")
			.orderBy("item.context_id")
			.orderBy("item.ordinal")
			.execute();
		const guardDigest = canonicalJsonDigest({
			session: JSON.parse(JSON.stringify(session)),
			thread: { ...thread, messages: undefined },
			durableDigest: canonicalJsonDigest(items),
		});
		if (
			guardDigest !== args.guardDigest ||
			canonicalJsonDigest(thread.messages) !== args.transcriptDigest ||
			thread.design_session_id !== session.id ||
			session.owner_user_id !== before.ownerUserId
		)
			throw new Error("Scan evidence changed. Scan again before repairing.");
		if (
			session.mode !== "build" ||
			session.state !== "active" ||
			session.app_id !== null ||
			designSessionLeaseState(session).live ||
			thread.active_stream_id !== null
		)
			throw new Error(
				"Repair requires an inactive, pre-app build session with no active stream.",
			);
		const plan = planAuthoringAmplificationRepair(
			thread.messages,
			verifiedMessages(items) ?? [],
		);
		if (!plan)
			throw new Error(
				"The repeated final response no longer has one durable origin.",
			);
		if (args.apply) {
			// A cap-zero tombstone makes the stored repaired copy authoritative even
			// when an old browser later submits its much larger version.
			const tombstones = thread.clawed_back_ids.filter(
				(entry) =>
					(typeof entry === "string" ? entry : entry.id) !== plan.messageId,
			);
			tombstones.push({ id: plan.messageId, cap: 0 });
			await tx
				.updateTable("threads")
				.set({
					messages: JSON.stringify(plan.messages),
					clawed_back_ids: JSON.stringify(tombstones),
					updated_at: new Date().toISOString(),
				})
				.where("thread_id", "=", args.threadId)
				.executeTakeFirstOrThrow();
		}
		return {
			applied: args.apply,
			threadId: args.threadId,
			removedParts: plan.removedParts,
			beforeDigest: plan.beforeDigest,
			afterDigest: plan.afterDigest,
		};
	});
}
