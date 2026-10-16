/** Typed navigation display-condition emission for suite.xml and HQ JSON. */

import {
	emitCasePropertyWirePath,
	RESERVED_CASE_ATTRIBUTES,
} from "@/lib/commcare/casePropertyWire";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import type { Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { displayConditionForEmission } from "@/lib/domain/predicate";

/** A menu or a form, as its display condition is emitted: the stored
 * condition and whether the item is off the menu. */
export interface DisplayConditionCarrier {
	readonly displayCondition?: Predicate;
	readonly hiddenFromMenu?: true;
}

/** The written `false()` an item off the menu leads with. */
const OFF_THE_MENU = "false()";

/**
 * An item off the menu writes `false()` alone, or `false() and (<rest>)`
 * where it holds a condition for when it is back on the menu; the rest's
 * parentheses are always written, which is the spelling HQ's module and form
 * settings saves keep character for character. An item on the menu writes
 * its condition as stored, or nothing.
 */
function withMenuPresence(
	carrier: DisplayConditionCarrier,
	emitRest: (rest: Predicate) => string,
): string | undefined {
	const rest = displayConditionForEmission(carrier.displayCondition);
	const restText = rest === undefined ? undefined : emitRest(rest);
	if (carrier.hiddenFromMenu !== true) return restText;
	return restText === undefined
		? OFF_THE_MENU
		: `${OFF_THE_MENU} and (${restText})`;
}

function selectedCase(selectedCaseDatumId = "case_id"): string {
	return `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/${selectedCaseDatumId}]`;
}

/** Module relevancy runs before case selection, so ordinary on-device terms
 * emit directly; validation has already excluded every case-row term. */
export function emitModuleDisplayCondition(
	carrier: DisplayConditionCarrier,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
): string | undefined {
	return withMenuPresence(carrier, (rest) =>
		emitCaseListFilter(
			rest,
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
		),
	);
}

/**
 * A form command in a case-first menu evaluates after `case_id` is selected,
 * but its context node is not the case row. Anchor every admitted direct-self
 * property structurally through the selected session datum. No emitted-string
 * rewriting is used: the leaf override is threaded through the typed emitter.
 */
export function emitFormDisplayConditionForSuite(
	carrier: DisplayConditionCarrier,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
	selectedCaseDatumId?: string,
): string | undefined {
	return withMenuPresence(carrier, (rest) =>
		emitCaseListFilter(
			rest,
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
		),
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
	carrier: DisplayConditionCarrier,
	currentCaseType?: string,
	lookupNaming?: LookupWireNaming,
	userPropertySlugs?: ReadonlyMap<Uuid, string>,
	selectedCaseDatumId?: string,
): string | undefined {
	return withMenuPresence(carrier, (rest) =>
		emitCaseListFilter(
			rest,
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
		),
	);
}
