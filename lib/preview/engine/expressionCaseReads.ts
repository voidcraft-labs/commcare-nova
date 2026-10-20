import type { BlueprintDoc } from "@/lib/domain";
import {
	type Expression,
	isTerm,
	type Term,
} from "@/lib/domain/expression/types";
import {
	type ExpressionVisitor,
	walkExpression,
	walkTerm,
} from "@/lib/domain/expression/walk";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";

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
	expression: Expression | Term,
	doc?: Pick<BlueprintDoc, "fields">,
): boolean {
	let reads = false;
	const visitor: ExpressionVisitor = {
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
	};
	if (isTerm(expression)) walkTerm(expression, visitor, []);
	else walkExpression(expression, visitor);
	return reads;
}

function queryBound(
	field: BlueprintDoc["fields"][string] | undefined,
): boolean {
	return field?.kind === "repeat" && field.repeat_mode === "query_bound";
}

/** Whether one tree reads the worker's places: a `locations` read, or a case
 * owner named as the place at a level, which reads the fixture too. */
function expressionReadsPlaces(expression: Expression): boolean {
	let reads = false;
	walkExpression(expression, {
		visitExpression: (node) => {
			if (node.kind === "locations") reads = true;
		},
		visitTerm: (term) => {
			if (term.kind === "owner-location-at-level") reads = true;
		},
	});
	return reads;
}

/**
 * Whether any form of the app, its questions or its links reads the worker's
 * places, so its device snapshot carries the `locations` fixture. Only form
 * logic and form links can read places (`typeChecker.ts::admission` refuses
 * them in record rules), so these are the only owners scanned. Preview's
 * snapshot, App Tests and the form check (`evaluate_form`) all load places by
 * this one answer.
 */
export function appReadsPlaces(doc: BlueprintDoc): boolean {
	return [
		...Object.values(doc.forms).map((form) => ({
			entity: "form" as const,
			uuid: form.uuid,
		})),
		...Object.values(doc.fields).map((field) => ({
			entity: "field" as const,
			uuid: field.uuid,
		})),
	].some((owner) =>
		expressionSlotValues(doc, owner).some(({ expression }) =>
			expressionReadsPlaces(expression),
		),
	);
}
