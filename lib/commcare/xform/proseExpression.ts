import type { Expression } from "@/lib/domain/expression/types";
import type { ProseReferencePart } from "@/lib/domain/prose";

/** Prose remains its own authored model; a reference lowers through the same
 * identity-aware form expression boundary as a calculated form value. */
export function proseReferenceExpression(part: ProseReferencePart): Expression {
	switch (part.kind) {
		case "field-ref":
			return { kind: "term", term: { kind: "field", uuid: part.uuid } };
		case "case-ref":
			return {
				kind: "term",
				term: {
					kind: "form-case",
					caseType: part.caseType,
					property: part.property,
				},
			};
		case "user-property-ref":
			return {
				kind: "term",
				term: {
					kind: "session-user-property",
					userPropertyUuid: part.userPropertyUuid,
					source: "worker-record",
				},
			};
		case "user-ref":
			return {
				kind: "term",
				term: {
					kind: "session-user",
					field: part.property,
					source: "worker-record",
				},
			};
	}
}
