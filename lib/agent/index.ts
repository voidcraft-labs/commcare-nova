// lib/agent/index.ts
//
// Public barrel for the lib/agent layer. Server-only: every symbol here
// transitively imports the LLM provider layer and the server data layer.

// errorClassifier — shared error taxonomy + user-facing messages.
export type { ClassifiedError, ErrorType } from "./errorClassifier";
export { classifyError, MESSAGES } from "./errorClassifier";
// generationContext — shared LLM wrapper around the AI Gateway provider, SSE
// writer, event log, and usage accumulator.
export { GenerationContext, logWarnings } from "./generationContext";
// prompts — the per-turn app-state message an edit turn appends to the end
// of its prompt (the system prompt itself is static; the SA factory renders
// it internally).
export { buildAppStateMessage } from "./prompts";
// resolveAttachments — server-side resolution of chat attachment refs. The
// composer sends asset-id refs in message metadata; the chat route calls
// `resolveAttachments` to append each ref's stored requirements extract
// (documents) or image bytes (vision) to the message before it reaches the
// Solutions Architect, and `countDocumentsNeedingRead` to decide whether to show
// the "reading documents" status — only when a document still needs extracting,
// not for one already read.
export {
	countDocumentsNeedingRead,
	resolveAttachments,
} from "./resolveAttachments";
// solutionsArchitect — the one ToolLoopAgent factory.
export { createSolutionsArchitect } from "./solutionsArchitect";

// turnRetry — the chat route's transient mid-stream failure re-run policy.
export {
	buildTurnRetryContinuation,
	shouldRetryTurn,
	TURN_RETRY_MESSAGE,
	turnRetryDelayMs,
} from "./turnRetry";
