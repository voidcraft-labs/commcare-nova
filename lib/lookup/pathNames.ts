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

export function hasInterpolatedNamePeriod(name: string): boolean {
	return /(?<!\p{Nd})\.(?!\p{Nd})/u.test(name);
}

export type LookupPathNameIssue =
	| "unreadable-name"
	| "interpolated-period"
	| "undeclared-instance";

export function lookupPathNameExplanation(issue: LookupPathNameIssue): string {
	switch (issue) {
		case "unreadable-name":
			return "A platform this app runs on can't read this name in a data path.";
		case "interpolated-period":
			return "CommCare HQ changes a period in this name when it builds this condition.";
		case "undeclared-instance":
			return "CommCare HQ can't find this table by its export name when it builds this screen.";
	}
}

export function lookupPathNameIssue(
	name: string,
	registrySlot: string,
	part: "tag" | "column",
	platforms: readonly Platform[] = PLATFORMS,
): LookupPathNameIssue | null {
	if (!isPortableName(name, platforms)) return "unreadable-name";
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
 * filter goes through every lookup name restriction. */
export function lookupNameNeedsUseCheck(
	name: string,
	part: "tag" | "column",
): boolean {
	return lookupPathNameIssue(name, "case_list_filter", part) !== null;
}
