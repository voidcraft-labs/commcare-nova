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
//   export type { ClassifiedError } from "./errorClassifier";
//   export { GenerationContext, logWarnings, thinkingProviderOptions } from "./generationContext";
//   export { computeScaffoldProgress } from "./scaffoldProgress";
//   export { createSolutionsArchitect, validateAndFix } from "./solutionsArchitect";
//
// Individual move tasks add these exports one at a time.

export type { ClassifiedError } from "./errorClassifier";
// Task 3: errorClassifier moved in from lib/services/.
export { classifyError, MESSAGES } from "./errorClassifier";
