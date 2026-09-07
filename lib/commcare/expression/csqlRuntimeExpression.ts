import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { ValueExpression } from "@/lib/domain/predicate/types";
import type { LookupWireNaming } from "../lookup/naming";
import { emitOnDeviceExpression } from "./onDeviceEmitter";

export interface CsqlEmissionContext extends TypeContext {
	readonly lookupNaming?: LookupWireNaming;
}

/** Runtime operands keep the same suite context at every native-call depth. */
export function emitCsqlRuntimeExpression(
	expr: ValueExpression,
	context?: CsqlEmissionContext,
): string {
	return emitOnDeviceExpression(
		expr,
		undefined,
		context ?? {},
		undefined,
		context?.lookupNaming === undefined
			? {}
			: {
					lookup: { naming: context.lookupNaming, instanceScope: "suite" },
				},
	);
}
