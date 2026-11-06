import { APICallError, type LanguageModelUsage } from "ai";

export class AgentModelStepError extends Error {
	constructor(
		cause: unknown,
		readonly usage: LanguageModelUsage | undefined,
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = cause instanceof Error ? cause.name : "AgentModelStepError";
	}
}

/** Provider metadata is operational evidence, never prompt or response content. */
export function modelFailureDiagnostics(error: unknown): {
	providerStatus?: number;
	providerRequestId?: string;
} {
	const cause = error instanceof AgentModelStepError ? error.cause : error;
	if (!APICallError.isInstance(cause)) return {};
	const requestId = cause.responseHeaders?.["x-request-id"];
	return {
		...(cause.statusCode !== undefined && { providerStatus: cause.statusCode }),
		...(requestId &&
			/^[a-zA-Z0-9_-]{1,200}$/.test(requestId) && {
				providerRequestId: requestId,
			}),
	};
}
