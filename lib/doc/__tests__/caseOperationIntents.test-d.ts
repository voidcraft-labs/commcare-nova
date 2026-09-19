import { expectTypeOf } from "vitest";
import type { retargetCaseOperationLink } from "@/lib/doc/caseOperationIntents";

expectTypeOf<{ kind: "new" }>().not.toExtend<
	Parameters<typeof retargetCaseOperationLink>[1]
>();
