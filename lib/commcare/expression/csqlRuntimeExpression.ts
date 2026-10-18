import { expressionChildren } from "@/lib/domain/expression/children";
import { expressionChildContext } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import { toWire, type WireBuildContext } from "../xpath/wire/fromExpression";
import type { WireExpr } from "../xpath/wire/tree";

export type CsqlEmissionContext = Omit<WireBuildContext, "target">;

/** Runtime operands keep the actual suite slot context at every native depth. */
export function emitCsqlRuntimeExpression(
	expr: Expression,
	context: CsqlEmissionContext,
): WireExpr {
	return toWire(expr, { ...context, target: "csql-runtime" });
}

/** Rebind only semantic scope; runtime name and value bindings remain unchanged. */
export function csqlChildContext(
	parent: Expression,
	slot: string,
	context: CsqlEmissionContext,
): CsqlEmissionContext {
	const child = expressionChildren(parent).find(
		(entry) => entry.role.kind === "operand" && entry.role.slot === slot,
	);
	return child === undefined
		? context
		: {
				...context,
				types: expressionChildContext(parent, child, context.types),
			};
}
