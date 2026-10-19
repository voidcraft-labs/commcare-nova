/**
 * Which forms of an app read `jr://fixture/locations`.
 *
 * The wire serializer's returned dependencies decide: every expression a form
 * carries (its questions' logic, its Connect blocks, its case operations and
 * its after-submit links) is lowered by `xpath/wire/fromExpression.ts::toWire`
 * the way its emitter lowers it, and a form reads the fixture when one
 * printed tree declares `locations`. A place destination's
 * `owner-location-at-level` arm and every `locations` read declare it; a
 * fixed location prints a literal and a `location-level` prints a level's
 * code, so neither declares anything. No domain walk stands beside the
 * serializer's answer.
 *
 * A link's condition and datum values run in the source entry's session,
 * whose evaluation context holds the entry's declared instances
 * (`CommCareSession.java::getEvaluationContext`), so a link that reads places
 * reads the same device fixture its form does and counts for that form.
 *
 * The decision ignores which lookup table a tree reads, so a tree that also
 * reads a table prints under `identityLookupWireNaming`, which names every
 * table and column by its own id.
 *
 * A worker's restore holds the flat location list only where the project
 * space sends it (every app carries `location_fixture_restore:
 * "project_default"`, `hqShells.ts::applicationShell`), so publish asks the
 * person to confirm that for an app this names any form of, and the plan
 * privilege `locations` follows the same forms.
 */

import {
	descendantFieldUuids,
	orderedFormUuids,
	orderedModuleUuids,
} from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type {
	DatumRef,
	FormExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import { caseTypeDepthMap } from "../caseTypeDepths";
import {
	entryDatumIdResolver,
	entryDatumIds,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
	projectFormLinkSessionExpression,
} from "../formLinkProjection";
import { identityLookupWireNaming } from "../lookup/naming";
import { formCasePropertyRead } from "../xform/formCaseRead";
import { formExpressionEmission } from "../xform/formExpressions";
import { w } from "../xpath/wire/builders";
import { locationsInstance } from "../xpath/wire/instances";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr } from "../xpath/wire/tree";

/**
 * Why a form reads the fixture: `owner` when only a case operation's owner
 * names a place at a level, `reads` when any other expression of the form or
 * of its links reads places.
 */
export interface FormReadingLocations {
	readonly formUuid: Uuid;
	readonly why: "owner" | "reads";
}

/** Whether one printed tree declares the flat location fixture. */
function declaresLocations(wire: WireExpr, target: "xform" | "suite"): boolean {
	const fixture = locationsInstance();
	return [...serializeWire(wire, { target, constraint: false }).instances].some(
		(declaration) =>
			declaration.id === fixture.id && declaration.src === fixture.src,
	);
}

/** The slots a form's after-submit links carry, printed into its suite entry. */
function isLinkSlot(ref: FormExpressionSlotRef): boolean {
	return (
		ref.slot === "form_link_condition" || ref.slot === "form_link_datum_xpath"
	);
}

/** Every place read of one form, in the serializer's words. */
function formReadsLocations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
	links: () => FormLinkProjectionContext,
): FormReadingLocations["why"] | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const naming = identityLookupWireNaming();
	const moduleCaseType = doc.modules[moduleUuid]?.caseType;
	let datumId: ((ref: DatumRef) => string | undefined) | undefined;
	const expressions = formExpressionEmission(doc, formUuid, naming, {
		formCaseProperty: formCasePropertyRead({
			formType: form.type,
			caseTypeDepths: caseTypeDepthMap(moduleCaseType, doc.caseTypes ?? []),
			moduleCaseType,
		}),
		organizationLevels: doc.organizationLevels ?? {},
		lookup: { naming, instanceScope: "xform" },
		// A case operation's reads of an earlier operation's case id name
		// a node of this form, never an instance.
		operationIds: new Map(
			(form.caseOperations ?? []).map((operation) => [
				operation.uuid,
				w.context([w.attr("case_id")]),
			]),
		),
		datumId: (ref) => {
			datumId ??= entryDatumIdResolver(
				entryDatumIds(doc, links(), moduleUuid, formUuid),
			);
			return datumId(ref);
		},
	});
	let owner = false;
	for (const { ref, expression } of expressionSlotValues(doc, {
		entity: "form",
		uuid: formUuid,
	})) {
		if (ref.entity !== "form") continue;
		if (isLinkSlot(ref)) {
			if (
				declaresLocations(
					projectFormLinkSessionExpression(
						doc,
						links(),
						formUuid,
						expression,
						ref,
					),
					"suite",
				)
			)
				return "reads";
			continue;
		}
		if (!declaresLocations(expressions.lower(expression, ref), "xform"))
			continue;
		if (ref.slot !== "case_operation_owner") return "reads";
		owner = true;
	}
	for (const fieldUuid of descendantFieldUuids(doc, formUuid))
		for (const { ref, expression } of expressionSlotValues(doc, {
			entity: "field",
			uuid: fieldUuid,
		}))
			if (declaresLocations(expressions.lower(expression, ref), "xform"))
				return "reads";
	return owner ? "owner" : undefined;
}

/** The forms whose wire reads the flat location list, in the document's
 * form order. */
export function formsReadingLocationsFixture(
	doc: BlueprintDoc,
): FormReadingLocations[] {
	let links: FormLinkProjectionContext | undefined;
	const linkContext = () => {
		links ??= formLinkProjectionContext(doc, {
			entryMetadataOnly: true,
			lookupNaming: identityLookupWireNaming(),
		});
		return links;
	};
	const forms: FormReadingLocations[] = [];
	for (const moduleUuid of orderedModuleUuids(doc)) {
		for (const formUuid of orderedFormUuids(doc, moduleUuid)) {
			const why = formReadsLocations(doc, moduleUuid, formUuid, linkContext);
			if (why !== undefined) forms.push({ formUuid, why });
		}
	}
	return forms;
}

/** Whether this app's wire reads `jr://fixture/locations`. */
export function readsLocationsFixture(doc: BlueprintDoc): boolean {
	return formsReadingLocationsFixture(doc).length > 0;
}
