import type { Column } from "@/lib/domain";
import type { WireExpr } from "../../xpath/wire/tree";
import { hqColumnFieldText, isHqDetailField } from "../wire";

/** A worker may see the value of a fixture field directly or a calculation
 * over that value. HQ gives the two different header identities and keeps
 * them in different controls. A table rename follows the column identity.
 * A subsequent expression edit that needs a calculation uses that control.
 * Translated wording and formatted text need HQ's calculated field, so they
 * never print as a direct field. */
export function fixtureRowFieldName(
	column: Column,
	path: WireExpr,
	heldWord?: string,
) {
	if (
		column.kind !== "calculated" ||
		!column.rowField ||
		column.texts !== undefined ||
		column.showAs === "formatted-text" ||
		column.expression.kind !== "term" ||
		!["table-column", "location-field"].includes(column.expression.term.kind) ||
		path.k !== "path" ||
		path.root.k !== "context" ||
		path.steps.length !== 1
	)
		return;
	const step = path.steps[0];
	if (!step.name || step.predicates.length || !isHqDetailField(step.name))
		return;
	if (step.axis === "attribute")
		return ["owner_id", "status"].includes(step.name) ? step.name : undefined;
	if (
		step.axis !== "child" ||
		["name", "owner_id", "status", "external-id", "date-opened"].includes(
			step.name,
		)
	)
		return;
	return hqColumnFieldText(step.name, heldWord);
}
