import type { LookupAgentWriteScope } from "@/lib/lookup/types";
import type { ToolInvocationContext } from "../../workspace/types";
import { requireInvocationAppId } from "../common";

/** One server-owned authority projection for lookup reads, writes, and replay. */
export function lookupAgentScope(
	ctx: ToolInvocationContext,
): LookupAgentWriteScope {
	const target = ctx.ordinaryAuthoring
		? { ordinaryAuthoring: ctx.ordinaryAuthoring }
		: ctx.authoringSessionId
			? { designSessionId: ctx.authoringSessionId }
			: { appId: requireInvocationAppId(ctx) };
	return {
		...target,
		projectId: ctx.projectId,
		actorId: ctx.userId,
		runId: ctx.runId,
		requestId: ctx.invocation.requestId,
		...(ctx.chatRunHolder === undefined
			? {}
			: { chatRunHolder: ctx.chatRunHolder }),
	};
}
