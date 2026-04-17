// lib/agent/index.ts
//
// Public barrel for the lib/agent layer. Consumers outside this directory
// (`app/api/chat/route.ts`, `app/api/compile/route.ts`, chat UI) import
// from here, not from the individual files.
//
// Tasks 3–11 of the Phase 3 plan move files into this directory and the
// barrel's re-exports populate as they land. The phase's final state looks
// like:
//
//   export { AutoFixer } from "./autoFixer";
//   export { classifyError, MESSAGES } from "./errorClassifier";
//   export type { ClassifiedError, ErrorType } from "./errorClassifier";
//   export { GenerationContext, logWarnings, thinkingProviderOptions } from "./generationContext";
//   export { computeScaffoldProgress } from "./scaffoldProgress";
//   export { createSolutionsArchitect, validateAndFix } from "./solutionsArchitect";
//
// Individual move tasks add these exports one at a time.

// Task 7: autoFixer moved in from lib/services/. Exported through the barrel
// because `app/api/compile/route.ts` is an external consumer.
export { AutoFixer } from "./autoFixer";
export type { ClassifiedError, ErrorType } from "./errorClassifier";
// Task 3: errorClassifier moved in from lib/services/.
export { classifyError, MESSAGES } from "./errorClassifier";
// Task 4: generationContext moved in from lib/services/. `DocProvider` is an
// internal wiring type (accepted by `registerDocProvider`) — not re-exported
// because no external consumer constructs one.
export {
	GenerationContext,
	logWarnings,
	thinkingProviderOptions,
} from "./generationContext";
// Task 5: scaffoldProgress moved in from lib/services/. Re-exported from the
// barrel because `components/chat/ChatSidebar.tsx` (an external consumer)
// reaches for it. `contentProcessing` stayed out of the barrel on purpose —
// its only consumer is solutionsArchitect (also in lib/agent/ after Task 10),
// so it stays an internal implementation detail.
export { computeScaffoldProgress } from "./scaffoldProgress";
