import type { BlueprintDoc } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";

/**
 * Structural dependencies only. Literal strings never request case data.
 *
 * A read of the worker's places counts as well: the `locations` fixture
 * travels with the device snapshot.
 *
 * The session datums that are functions over casedb count too: the worker's
 * record (`usercase_id`) and a grouped tile's companion
 * (`<datum>_parent_ids`) are evaluated over the device's cases when the entry
 * begins (`entrySessionData.ts`), so without the snapshot they read blank. A
 * row projection reads a row's values the same way, and so does a row of a
 * query-bound repeat, whose rows are the cases its query matched; `doc`
 * names which repeats those are.
 */
export function expressionReadsCaseDatabase(
	expression: Expression,
	doc?: Pick<BlueprintDoc, "fields">,
): boolean {
	let reads = false;
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "cases" && node.source === "casedb") reads = true;
			if (node.kind === "project") reads = true;
			// The worker's places ride the device snapshot, as a restore
			// delivers its `locations` fixture beside the cases.
			if (node.kind === "locations") reads = true;
		},
		visitTerm: (term) => {
			if (
				(term.kind === "session-datum" &&
					(term.datum.kind === "worker-record" ||
						term.datum.kind === "tile-group-parents")) ||
				(term.kind === "repeat-row" && queryBound(doc?.fields[term.repeat])) ||
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

function queryBound(
	field: BlueprintDoc["fields"][string] | undefined,
): boolean {
	return field?.kind === "repeat" && field.repeat_mode === "query_bound";
}
