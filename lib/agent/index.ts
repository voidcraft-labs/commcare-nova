// lib/agent/index.ts
//
// Public barrel for the lib/agent layer. External consumers
// (`app/api/chat/route.ts`, `app/api/compile/route.ts`, chat UI) import
// from here, not from the individual files.

// autoFixer — used by `app/api/compile/route.ts` for the standalone fix pass.
export { AutoFixer } from "./autoFixer";
// errorClassifier — shared error taxonomy + user-facing messages.
export type { ClassifiedError, ErrorType } from "./errorClassifier";
export { classifyError, MESSAGES } from "./errorClassifier";
// generationContext — shared LLM wrapper. `DocProvider` is an internal wiring
// type (accepted by `registerDocProvider`) and not re-exported because no
// external consumer constructs one.
export {
	GenerationContext,
	logWarnings,
	thinkingProviderOptions,
} from "./generationContext";
// scaffoldProgress — consumed by `components/chat/ChatSidebar.tsx`.
// `contentProcessing` stays out of the barrel: its only consumer is
// `solutionsArchitect`, which is a sibling under lib/agent/.
export { computeScaffoldProgress } from "./scaffoldProgress";
// solutionsArchitect — the one ToolLoopAgent factory. `validateAndFix` is
// re-exported because `app/api/compile/route.ts` runs validation outside the
// SA run for the standalone fix endpoint.
export { createSolutionsArchitect, validateAndFix } from "./solutionsArchitect";
