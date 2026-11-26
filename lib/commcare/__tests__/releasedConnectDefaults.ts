/** The explicit expressions the released form configuration printed when
 * these inputs were left blank. Compatibility fixtures exercise these exact values. */
import type { Expression } from "@/lib/domain/expression/types";
export const DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION: Expression = {
	kind: "term",
	term: { kind: "session-user", field: "username", source: "worker-record" },
};
export const DEFAULT_DELIVER_ENTITY_ID_EXPRESSION: Expression = {
	kind: "concat",
	parts: [
		DEFAULT_DELIVER_ENTITY_NAME_EXPRESSION,
		{ kind: "term", term: { kind: "literal", value: "-" } },
		{ kind: "today" },
	],
};
export const DEFAULT_ASSESSMENT_USER_SCORE_EXPRESSION: Expression = {
	kind: "term",
	term: { kind: "literal", value: 100 },
};
