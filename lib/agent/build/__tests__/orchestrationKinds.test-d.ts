import { expectTypeOf } from "vitest";
import type { BuildOrchestrationKind } from "../orchestrationKinds";
import type { BuildOrchestratorState } from "../orchestratorState";

// Compiler vocabulary contract only. Stored freeze behavior runs in PostgreSQL;
// progress terminal behavior runs against the real fold in progress.test.ts.
expectTypeOf<BuildOrchestrationKind>().toEqualTypeOf<
	BuildOrchestratorState["kind"]
>();
