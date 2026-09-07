import { expectTypeOf } from "vitest";
import type { AdmittedMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Mutation } from "@/lib/doc/types";
import type { MutatingToolResult } from "../common";

// Checked by npm run typecheck; runtime admission is exercised by mutationAdmission.test.ts.
type ReturnedMutations = MutatingToolResult<unknown>["mutations"];
expectTypeOf<AdmittedMutationBatch>().toExtend<ReturnedMutations>();
expectTypeOf<readonly []>().toExtend<ReturnedMutations>();
expectTypeOf<readonly Mutation[]>().not.toExtend<ReturnedMutations>();
expectTypeOf<
	readonly [{ kind: "setAppName"; name: string }]
>().not.toExtend<ReturnedMutations>();
