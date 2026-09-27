import "server-only";

import type { GenerationContext } from "../generationContext";
import type { WorkspaceSnapshot } from "../workspace/types";
import {
	beginWork,
	discardWork,
	executeWorkTool,
	getWork,
	getWorkSnapshot,
	saveWork,
} from "./session";

/** The embedded host supplies identity; the shared engine owns all state. */
export interface ChatWork {
	invoke(toolName: string, input: unknown, requestId: string): Promise<unknown>;
	status(): ReturnType<typeof getWork>;
	snapshot(): Promise<WorkspaceSnapshot>;
}

export async function openChatWork(
	ctx: GenerationContext,
	threadId: string,
): Promise<ChatWork> {
	const authority = {
		actorUserId: ctx.userId,
		host: { kind: "chat" as const, threadId, holder: ctx.chatRunHolder },
	};
	const opened = await beginWork({
		...authority,
		projectId: ctx.projectId,
		target: { appId: ctx.appId },
		requestId: `chat:${ctx.runId}`,
	});
	const scoped = { ...authority, workId: opened.workId };
	// The SDK dispatches siblings concurrently. Bind each operation in dispatch
	// order so a dependent form/question call sees the preceding staged change.
	let tail = Promise.resolve<unknown>(undefined);
	return {
		status: () => getWork(scoped),
		snapshot: () => getWorkSnapshot(scoped),
		invoke(toolName, input, requestId) {
			const operation = tail.then(async () => {
				if (toolName === "getWork") return getWork(scoped);
				if (toolName === "saveWork" || toolName === "discardWork") {
					const { expectedRevision } = input as { expectedRevision: string };
					const args = { ...scoped, requestId, expectedRevision };
					if (toolName === "discardWork") return discardWork(args);
					const result = await saveWork(args);
					if (
						result.saved &&
						typeof result.batchId === "string" &&
						typeof result.savedRevision === "number"
					) {
						await ctx.publishAuthoringCheckpoint(
							result.savedRevision,
							result.batchId,
						);
					}
					return result;
				}
				const result = await executeWorkTool({
					...scoped,
					requestId,
					toolName,
					input,
				});
				if (result.authoritativeCheckpoint) {
					await ctx.publishAuthoringCheckpoint(
						result.authoritativeCheckpoint.seq,
						result.authoritativeCheckpoint.batchId,
					);
				}
				return result.kind === "read" ? result.data : result.result;
			});
			tail = operation.catch(() => undefined);
			return operation;
		},
	};
}
