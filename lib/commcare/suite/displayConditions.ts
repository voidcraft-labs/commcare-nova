/** Typed navigation display-condition emission for suite.xml and HQ JSON. */

import {
	emitCasePropertyWirePath,
	RESERVED_CASE_ATTRIBUTES,
} from "@/lib/commcare/casePropertyWire";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import type { Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { effectiveDisplayConditionForEmission } from "@/lib/domain/predicate";

function selectedCase(selectedCaseDatumId = "case_id"): string {
	return `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/${selectedCaseDatumId}]`;
}

/** Module relevancy runs before case selection, so ordinary on-device terms
 * emit directly; validation has already excluded every case-row term. */
export function emitModuleDisplayCondition(
	condition: Predicate | undefined,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(
		effective,
		"casedb",
		{
			...(currentCaseType !== undefined && { currentCaseType }),
			...(userPropertySlugs !== undefined && { userPropertySlugs }),
		},
		undefined,
		{
			...(lookupNaming === undefined
				? {}
				: { lookup: { naming: lookupNaming, instanceScope: "suite" } }),
			...(userPropertySlugs === undefined ? {} : { userPropertySlugs }),
		},
	);
}

/**
 * A form command in a case-first menu evaluates after `case_id` is selected,
 * but its context node is not the case row. Anchor every admitted direct-self
 * property structurally through the selected session datum. No emitted-string
 * rewriting is used: the leaf override is threaded through the typed emitter.
 */
export function emitFormDisplayConditionForSuite(
	condition: Predicate | undefined,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
	selectedCaseDatumId?: string,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(
		effective,
		"casedb",
		{
			...(currentCaseType !== undefined && { currentCaseType }),
			...(userPropertySlugs !== undefined && { userPropertySlugs }),
		},
		undefined,
		{
			emitSelfProperty: (property) =>
				`${selectedCase(selectedCaseDatumId)}/${emitCasePropertyWirePath(property.property)}`,
			...(lookupNaming !== undefined && {
				lookup: { naming: lookupNaming, instanceScope: "suite" },
			}),
			...(userPropertySlugs !== undefined && { userPropertySlugs }),
		},
	);
}

/**
 * HQ expands `#case/<property>` in `form_filter` to the menu's selected case
 * while regenerating suite.xml (`suite_xml/sections/menus.py::
 * MenuContributor._get_commands`), choosing the datum itself. Its parser
 * expects a name after `#case/`, so a reserved case attribute cannot be read
 * that way: `#case/@status` fails `validate_app()` with a form filter xpath
 * error and the app does not build. A read of `case_id`, `case_type`,
 * `owner_id` or `status` is therefore written expanded, through the selected
 * case's session datum, the one spelling HQ builds for an attribute; every
 * other property keeps `#case/<property>`.
 */
export function emitFormDisplayConditionForHq(
	condition: Predicate | undefined,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
	selectedCaseDatumId?: string,
): string | undefined {
	const effective = effectiveDisplayConditionForEmission(condition);
	if (effective === undefined) return undefined;
	return emitCaseListFilter(
		effective,
		"casedb",
		{
			...(currentCaseType !== undefined && { currentCaseType }),
			...(userPropertySlugs !== undefined && { userPropertySlugs }),
		},
		undefined,
		{
			emitSelfProperty: (property) =>
				RESERVED_CASE_ATTRIBUTES.has(property.property)
					? `${selectedCase(selectedCaseDatumId)}/@${property.property}`
					: `#case/${property.property}`,
			...(lookupNaming !== undefined && {
				lookup: { naming: lookupNaming, instanceScope: "suite" },
			}),
			...(userPropertySlugs !== undefined && { userPropertySlugs }),
		},
	);
}
