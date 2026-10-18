import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";

/** Structural dependencies only. Literal strings never request case data. */
export function expressionReadsCaseDatabase(expression: Expression): boolean {
	let reads = false;
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "cases" && node.source === "casedb") reads = true;
		},
		visitTerm: (term) => {
			if (
				term.kind === "form-case" ||
				term.kind === "prop" ||
				term.kind === "case-index" ||
				term.kind === "case-row-type" ||
				term.kind === "owner-location-at-level" ||
				((term.kind === "session-user" ||
					term.kind === "session-user-property") &&
					term.source === "worker-record")
			)
				reads = true;
		},
		visitRelation: () => {
			reads = true;
		},
	});
	return reads;
}
