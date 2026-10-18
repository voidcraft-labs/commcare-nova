import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { ValueExpression } from "@/lib/domain/predicate/types";
import type { LookupWireNaming } from "../lookup/naming";
import { toWire } from "../xpath/wire/fromExpression";
import type { WireExpr } from "../xpath/wire/tree";

export interface CsqlEmissionContext extends TypeContext {
	readonly lookupNaming?: LookupWireNaming;
}

/** Runtime operands keep the same suite context at every native-call depth. */
export function emitCsqlRuntimeExpression(
	expr: ValueExpression,
	context?: CsqlEmissionContext,
): WireExpr {
	return toWire(expr, {
		target: "csql-runtime",
		types: context ?? {},
		bindings:
			context?.lookupNaming === undefined
				? {}
				: {
						lookup: { naming: context.lookupNaming, instanceScope: "suite" },
					},
	});
}
