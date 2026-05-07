// lib/agent/index.ts
//
// Public barrel for the lib/agent layer. Server-only: every symbol here
// transitively imports Anthropic and firebase-admin.

// autoFixer — used by `app/api/compile/route.ts` for the standalone fix pass.
export { AutoFixer } from "./autoFixer";
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
// solutionsArchitect — the one ToolLoopAgent factory. `validateAndFix` is
// re-exported because `app/api/compile/route.ts` runs validation outside the
// SA run for the standalone fix endpoint. `STRIP_TARGET_TOOL_NAMES` is the
// shared allowlist used by `app/api/chat/route.ts` to strip both build-only
// and fully-retired tool-use parts from edit-mode message history (the
// model rejects any tool reference whose name isn't in the current tools
// array, so retired tools must be stripped too — `BUILD_ONLY_TOOL_NAMES`
// alone misses any historical chat that used a since-deleted tool).
export {
	BUILD_ONLY_TOOL_NAMES,
	createSolutionsArchitect,
	RETIRED_TOOL_NAMES,
	STRIP_TARGET_TOOL_NAMES,
	validateAndFix,
} from "./solutionsArchitect";
