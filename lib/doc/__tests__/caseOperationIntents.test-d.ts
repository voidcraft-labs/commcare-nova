import { expectTypeOf } from "vitest";
import type { retargetCaseOperationLink } from "@/lib/doc/caseOperationIntents";

expectTypeOf<{ kind: "new" }>().not.toMatchTypeOf<
	Parameters<typeof retargetCaseOperationLink>[1]
>();
