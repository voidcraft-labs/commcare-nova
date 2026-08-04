import {
	type AutomationMessageTemplate,
	CASE_SCALAR_PROPERTY_NAMES,
} from "@/lib/domain";

/**
 * One Nova-to-HQ projection for every case-property slot in an automation.
 *
 * Most HQ automation readers call `CommCareCase.get_case_property()` or
 * `resolve_case_property()`. Those functions accept SQL model-field names,
 * not the alternate names used by CommCare detail columns and Nova. Update
 * targets use the same resolver before deciding whether a write is needed, so
 * projecting there also prevents a `case_name` update from firing forever.
 *
 * Two alert slots are deliberately different: reset-on-change and event time
 * read `dynamic_case_properties()` directly, so no standard scalar property is
 * representable in them. General reads project Nova's `case_type` to HQ's
 * model field `type`; neither `case_id` nor `case_type` is updateable. `status`
 * is also closed: Nova stores `open`/`closed`, while HQ exposes a boolean
 * `closed` model field and automation queries already exclude closed cases.
 *
 * Re-verified against commcare-hq 9c30a642ba3d718cfc30c479a6c32485df48a6b5:
 * - corehq/form_processor/models/cases.py::get_case_property,
 *   ::resolve_case_property, and CommCareCase model fields
 * - corehq/apps/data_interfaces/models.py::MatchPropertyDefinition and
 *   BaseUpdateCaseDefinition
 * - corehq/messaging/scheduling/tasks.py::_get_reset_case_property_value
 * - corehq/messaging/scheduling/models/timed_schedule.py::CasePropertyTimedEvent
 * - corehq/messaging/templating.py::_get_case_template_info
 */

export type AutomationHqPropertySlot =
	| "read"
	| "update-target"
	| "dynamic-only";

const STANDARD_HQ_READ_NAMES = {
	case_id: "case_id",
	case_type: "type",
	case_name: "name",
	date_opened: "opened_on",
	last_modified: "modified_on",
	owner_id: "owner_id",
	external_id: "external_id",
} as const satisfies Readonly<Record<string, string>>;

const NON_UPDATEABLE_STANDARD_PROPERTIES = new Set([
	"case_id",
	"case_type",
	"date_opened",
	"last_modified",
	"status",
]);

export function projectAutomationPropertyForHq(
	property: string,
	slot: AutomationHqPropertySlot,
): string | undefined {
	if (slot === "dynamic-only") {
		return CASE_SCALAR_PROPERTY_NAMES.has(property) ? undefined : property;
	}
	if (
		slot === "update-target" &&
		NON_UPDATEABLE_STANDARD_PROPERTIES.has(property)
	) {
		return undefined;
	}
	if (property === "status") return undefined;
	return Object.hasOwn(STANDARD_HQ_READ_NAMES, property)
		? STANDARD_HQ_READ_NAMES[property as keyof typeof STANDARD_HQ_READ_NAMES]
		: property;
}

export function describeAutomationPropertyForHq(
	property: string,
	slot: AutomationHqPropertySlot,
): string {
	const projected = projectAutomationPropertyForHq(property, slot);
	if (projected === undefined) return property;
	return projected === property
		? property
		: `${projected} (Nova property ${property})`;
}

/**
 * Project structural case-property atoms into HQ's template spelling.
 * Literal text that happens to contain `{case.foo}` remains literal text.
 * Validation guarantees every structural property is projectable before save.
 */
export function projectAutomationTemplateForHq(
	template: AutomationMessageTemplate,
): string {
	return template.parts
		.map((part) => {
			if (part.kind === "text") return part.text;
			const projected = projectAutomationPropertyForHq(part.property, "read");
			return projected === undefined
				? "{case.[reference needs repair]}"
				: `{case.${part.scope === "case" ? "" : `${part.scope}.`}${projected}}`;
		})
		.join("");
}
