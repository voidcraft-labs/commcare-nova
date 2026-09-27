"use server";

import { z } from "zod";
import { AuthoringInputError } from "@/lib/agent/authoring/errors";
import { discardWork, listWork } from "@/lib/agent/authoring/session";
import { getSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { AuthoringAuthorityError } from "@/lib/db/authoringSessions";

const scopeSchema = z.strictObject({
	appId: z.string().min(1).max(255),
	threadId: z.string().uuid(),
});
const discardSchema = scopeSchema.extend({
	workId: z.string().uuid(),
	expectedRevision: z.string().min(1).max(512),
	requestId: z.string().uuid(),
});

/** Only the actor's work in this conversation is exposed. The session engine
 * independently reauthorizes the immutable owner and Project on every call. */
export async function readChatWork(input: z.infer<typeof scopeSchema>) {
	try {
		const { appId, threadId } = scopeSchema.parse(input);
		const session = await getSession();
		if (!session)
			return {
				success: false as const,
				error: "Sign in to see pending changes.",
			};
		await resolveAppScope(appId, session.user.id, "edit");
		const work = await listWork({
			actorUserId: session.user.id,
			appId,
			host: { kind: "chat", threadId },
			limit: 1,
		});
		const pending = work.work[0];
		return {
			success: true as const,
			work: pending
				? {
						workId: pending.workId,
						revision: pending.revision,
						pendingChanges: pending.pendingChanges,
						stale: pending.stale,
					}
				: null,
		};
	} catch {
		return {
			success: false as const,
			error: "Nova couldn't check pending changes. Try again.",
		};
	}
}

/** No model request. The engine locks the owner/app and refuses while any run
 * remains active, including the interval after a browser requests cancellation. */
export async function discardChatWork(input: z.infer<typeof discardSchema>) {
	try {
		const { appId, threadId, workId, expectedRevision, requestId } =
			discardSchema.parse(input);
		const session = await getSession();
		if (!session)
			return {
				success: false as const,
				error: "Sign in to discard pending changes.",
			};
		await resolveAppScope(appId, session.user.id, "edit");
		await discardWork({
			actorUserId: session.user.id,
			workId,
			expectedRevision,
			requestId,
			host: { kind: "chat", threadId },
		});
		return { success: true as const };
	} catch (error) {
		return {
			success: false as const,
			error:
				error instanceof AuthoringInputError ||
				error instanceof AuthoringAuthorityError
					? error.message
					: "Nova couldn't discard these changes. Try again.",
		};
	}
}
