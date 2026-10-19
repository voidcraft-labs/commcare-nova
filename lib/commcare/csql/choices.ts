import { choiceValue } from "@/lib/domain/expression/choiceValue";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import type { Expression } from "@/lib/domain/expression/types";

/** CSQL checks and emission see the same current wire tokens for choice identities. */
export function materializeCsqlChoices(
	expression: Expression,
	context: ExpressionContext,
): Expression {
	return mapExpressionAst(expression, {
		mapTerm: (term) =>
			term.kind === "choice"
				? { kind: "literal", value: choiceValue(term, context.facts.options) }
				: term,
	});
}
