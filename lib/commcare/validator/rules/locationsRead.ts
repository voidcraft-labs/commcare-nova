/**
 * A read of the organization's places in an app that has no organization.
 *
 * Form logic and a form link's condition and datum values read the flat
 * location list (`instance('locations')/locations/location`), which HQ fills
 * from the worker's assigned places (`locations/fixtures.py::FlatLocationSerializer`).
 * An app with no organization levels pushes no places
 * (`lib/deployment/service.ts`, the `organizationLevelsOf` guard), so such a
 * read could only name places someone made in HQ, which Preview cannot show
 * and Nova does not describe. The rule reads the stored tree without typing
 * it, so it sits beside the checker rather than in it.
 */

import type { ExpressionContext } from "@/lib/domain/expression/context";
import { expressionSlotLabel } from "@/lib/domain/expression/slotLabels";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import type { FormLogicFinding } from "../formLogicFindings";

export function locationsReadNeedsOrganization(
	expression: Expression,
	ctx: ExpressionContext,
): readonly FormLogicFinding[] {
	if (Object.keys(ctx.facts.organizationLevels).length > 0) return [];
	let path: FormLogicFinding["path"];
	walkExpression(expression, {
		visitExpression: (node, at) => {
			if (path === undefined && node.kind === "locations") path = at;
		},
	});
	if (path === undefined) return [];
	const field =
		ctx.slot.entity === "field"
			? ctx.form?.fields.get(ctx.slot.uuid)
			: undefined;
	const label = expressionSlotLabel(ctx.slot.slot);
	const subject =
		field === undefined ? `This ${label}` : `"${field.id}"'s ${label}`;
	return [
		{
			code: "LOCATIONS_READ_NEEDS_ORGANIZATION",
			message: `${subject} reads places, but this app has no organization levels, so it pushes no places a worker's device could hold. You can add your organization's levels in App setup first.`,
			slot: ctx.slot,
			path,
		},
	];
}
