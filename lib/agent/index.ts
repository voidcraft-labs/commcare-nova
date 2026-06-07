// lib/agent/index.ts
//
// Public barrel for the lib/agent layer. Server-only: every symbol here
// transitively imports Anthropic and firebase-admin.

// errorClassifier — shared error taxonomy + user-facing messages.
export type { ClassifiedError, ErrorType } from "./errorClassifier";
export { classifyError, MESSAGES } from "./errorClassifier";
// generationContext — shared LLM wrapper around the Anthropic client, SSE
// writer, event log, and usage accumulator.
export {
	GenerationContext,
	logWarnings,
	thinkingProviderOptions,
} from "./generationContext";
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
// solutionsArchitect — the one ToolLoopAgent factory. `validateAndFix` is
// re-exported because `app/api/compile/route.ts` runs validation outside the
// SA run for the standalone fix endpoint. `BUILD_ONLY_TOOL_NAMES` is the
// shared allowlist used by `app/api/chat/route.ts` to strip build-only
// tool-use parts from edit-mode message history.
export {
	BUILD_ONLY_TOOL_NAMES,
	createSolutionsArchitect,
	validateAndFix,
} from "./solutionsArchitect";
