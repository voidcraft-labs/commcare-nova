import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import { isPortableName } from "@/lib/domain/portableName";
import { MODULE_REFERENCE_SLOTS } from "@/lib/domain/referenceSlots";

/** HQ discovers suite instance declarations by scanning the compiled XPath
 * for a literal instance id containing only Python word characters, "-" or
 * ":". A namespace-free table tag can never contain ":". XForms declare
 * their instances explicitly and do not depend on this scan. */
const SUITE_SLOTS: ReadonlySet<string> = new Set([
	...MODULE_REFERENCE_SLOTS.filter(
		(entry) => entry.kind === "expression" || entry.kind === "options-source",
	).map((entry) => entry.slot),
	"form_display_condition",
	"form_link_condition",
	"form_link_datum_xpath",
]);

/** HQ rewrites dots in these conditions using its case context. A period
 * next to a decimal digit survives dot_interpolate on either side. */
const DOT_INTERPOLATED_SLOTS: ReadonlySet<string> = new Set([
	"module_display_condition",
	"form_display_condition",
	"case_list_filter",
	"excluded_owner_ids",
	"search_input_required_when",
]);

/** CommCare HQ checks these conditions with its own XPath reader before it
 * builds an app (`helpers/validators.py`: `module_filter`, `form_filter`) or
 * saves the search options (`views/modules.py`:
 * `blacklisted_owner_ids_expression`, `search_button_display_condition`).
 * That reader is js-xpath, whose names hold only unaccented letters, digits,
 * `_`, `.` and `-` (`xpath.jisonlex`: `NCName`). */
const HQ_CHECKED_SLOTS: ReadonlySet<string> = new Set([
	"module_display_condition",
	"form_display_condition",
	"search_button_display_condition",
	"excluded_owner_ids",
]);

/** The slot a select's choices from a table hold: the table and the
 * columns its choices show and save. HQ's form builder compares the label
 * and value refs with the table's names as text (`itemset.js`:
 * `validateRefWidget`) and keeps them as written; it reads the nodeset's
 * path, the table's tag, with its XPath reader. */
const ITEMSET_SLOT = "lookup_options_source";

/** The row filter of a select's choices from a table, which HQ's form
 * builder reads as XPath. The registry holds it under `lookup_options_source`
 * (`lib/doc/lookupReferences.ts`: its references' subpath ends `filter`). */
export const LOOKUP_OPTIONS_FILTER_SLOT = "lookup_options_filter";

/** The slot whose name rule a lookup reference answers to: a select's row
 * filter is read as form logic, the rest of its choices as the itemset.
 * `subpath` is the occurrence's canonical path below its slot
 * (`lib/doc/lookupReferences.ts::canonicalLookupReferenceSubpath`), where
 * the filter is the key segment `/k:filter`. */
export function lookupNameSlotOf(
	registrySlot: string,
	subpath: string,
): string {
	return registrySlot === ITEMSET_SLOT &&
		subpath.split("/").includes("k:filter")
		? LOOKUP_OPTIONS_FILTER_SLOT
		: registrySlot;
}

/** Form logic: every slot a form's own XPath holds but a select's choices.
 * HQ's form builder reads each with js-xpath, and one it cannot read it saves
 * with its own `#form/` references left in (proof 4 on
 * `targeted-lookup-non-ascii-names`: a calculate went to
 * `zones_b[clé = #form/area]`, and HQ's build refused it). */
function isFormLogicSlot(registrySlot: string): boolean {
	return !SUITE_SLOTS.has(registrySlot) && registrySlot !== ITEMSET_SLOT;
}

/** Whether CommCare HQ's own XPath reader, which its form builder and its
 * condition checks share (js-xpath `NCName`), reads `name` as a name. */
export function isFormBuilderXPathName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(name);
}

export function hasInterpolatedNamePeriod(name: string): boolean {
	return /(?<!\p{Nd})\.(?!\p{Nd})/u.test(name);
}

export type LookupPathNameIssue =
	| "unreadable-name"
	| "interpolated-period"
	| "undeclared-instance"
	| "hq-unreadable-name"
	| "form-builder-unreadable-name";

export function lookupPathNameExplanation(issue: LookupPathNameIssue): string {
	switch (issue) {
		case "unreadable-name":
			return "A platform this app runs on can't read this name in a data path.";
		case "interpolated-period":
			return "CommCare HQ changes a period in this name when it builds this condition.";
		case "undeclared-instance":
			return "CommCare HQ can't find this table by its export name when it builds this screen.";
		case "hq-unreadable-name":
			return "CommCare HQ checks this condition with its own reader, which takes only unaccented letters, digits, _, . and - in a name, and turns it down.";
		case "form-builder-unreadable-name":
			return "CommCare HQ's form builder reads a form's expressions with a reader that takes only unaccented letters, digits, _, . and - in a name, so a save there would break this form.";
	}
}

const LOOKUP_PATH_NAME_ISSUES: readonly LookupPathNameIssue[] = [
	"unreadable-name",
	"interpolated-period",
	"undeclared-instance",
	"hq-unreadable-name",
	"form-builder-unreadable-name",
];

/** The sentence a setting that reads a table or column by a name that
 * can't work there shows. Each part is optional so the copy renderer can
 * build it from a finding's details alone; `readableInWebApps` offers the
 * Web-Apps-only route when that platform alone could read the name. */
export function lookupPathNameSentence(input: {
	readonly name?: string;
	readonly part?: string;
	readonly issue?: string;
	readonly readableInWebApps: boolean;
}): string {
	const subject = input.part === "tag" ? "table" : "column";
	const named =
		input.name === undefined
			? `This setting uses a ${subject} export name that can't work here.`
			: `This setting uses the ${subject} export name “${input.name}”.`;
	const issue = LOOKUP_PATH_NAME_ISSUES.find((one) => one === input.issue);
	const recovery = input.readableInWebApps
		? `You can choose another ${subject}, or set the app to run in Web Apps only if that's where your workers use it.`
		: `You can choose another ${subject} for this setting.`;
	return issue === undefined
		? `${named} ${recovery}`
		: `${named} ${lookupPathNameExplanation(issue)} ${recovery}`;
}

export function lookupPathNameIssue(
	name: string,
	registrySlot: string,
	part: "tag" | "column",
	platforms: readonly Platform[] = PLATFORMS,
): LookupPathNameIssue | null {
	if (!isPortableName(name, platforms)) return "unreadable-name";
	if (HQ_CHECKED_SLOTS.has(registrySlot) && !isFormBuilderXPathName(name))
		return "hq-unreadable-name";
	// A form reads a table through its tag in a path HQ's form builder reads,
	// and the builder drops the declaration of an instance whose reads it
	// cannot lex; HQ then refuses the form ("Instance: item-list:ζωνες Does not
	// exists", proof 4 on targeted-lookup-non-ascii-names).
	if (
		(isFormLogicSlot(registrySlot) ||
			(registrySlot === ITEMSET_SLOT && part === "tag")) &&
		!isFormBuilderXPathName(name)
	)
		return "form-builder-unreadable-name";
	if (
		part === "tag" &&
		SUITE_SLOTS.has(registrySlot) &&
		!/^[\p{L}\p{N}_-]+$/u.test(name)
	)
		return "undeclared-instance";
	if (
		DOT_INTERPOLATED_SLOTS.has(registrySlot) &&
		hasInterpolatedNamePeriod(name)
	)
		return "interpolated-period";
	return null;
}

/** Project data can be used by apps on either platform. The case list
 * filter goes through every suite restriction, a display condition through
 * CommCare HQ's own check besides, and form logic through HQ's form
 * builder's reader. */
export function lookupNameNeedsUseCheck(
	name: string,
	part: "tag" | "column",
): boolean {
	return (
		lookupPathNameIssue(name, "case_list_filter", part) !== null ||
		lookupPathNameIssue(name, "form_display_condition", part) !== null ||
		lookupPathNameIssue(name, LOOKUP_OPTIONS_FILTER_SLOT, part) !== null
	);
}
