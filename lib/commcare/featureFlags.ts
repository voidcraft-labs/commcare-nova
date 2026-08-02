/**
 * CommCare HQ feature-flag requirements for wire features Nova emits today.
 *
 * The JSON manifest is the lifecycle source of truth. The client-safe public
 * catalog/report vocabulary lives in `lib/publish/hqFeatureFlags.ts`; this
 * emission-boundary module owns only the exact BlueprintDoc → required-flags
 * projection because it depends on CommCare wire decisions.
 */

import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
} from "@/lib/domain";
import {
	featureFlagReportForUnverifiedRequirements,
	HQ_FEATURE_FLAG_REQUIREMENTS,
	type HqFeatureFlagId,
	type HqFeatureFlagReport,
	type HqFeatureFlagRequirement,
} from "@/lib/publish/hqFeatureFlags";
import { simpleArmNeedsXPathQueryEmission } from "./suite/case-search/simpleArmDerivation";

export * from "@/lib/publish/hqFeatureFlags";

/**
 * Whether the module crosses HQ's Advanced Case Search boundary.
 *
 * The HQ toggle does not gate the base search action. It covers the pieces
 * Nova projects into `_xpath_query`, prompt defaults, and custom search sort.
 * `excludedOwnerIds` and Search-action display copy deliberately do not count:
 * current HQ emits those without consulting CASE_SEARCH_ADVANCED.
 */
function moduleRequiresAdvancedCaseSearch(module: Module): boolean {
	if (effectiveCaseSearchConfig(module) === undefined) return false;
	const list = module.caseListConfig;
	if (!list) return false;
	if (list.filter !== undefined) return true;
	if (list.columns.some((column) => column.sort !== undefined)) return true;

	return list.searchInputs.some((input) => {
		if (input.kind === "advanced") return true;
		if ("default" in input && input.default !== undefined) return true;
		return simpleArmNeedsXPathQueryEmission(input);
	});
}

/** Exact, ordered set of HQ feature flags needed by this blueprint. */
export function requiredHqFeatureFlags(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagRequirement[] {
	const modules = Object.values(doc.modules);
	const ids = new Set<HqFeatureFlagId>();

	if (
		modules.some((module) => effectiveCaseSearchConfig(module) !== undefined)
	) {
		ids.add("case-search");
	}
	if (modules.some(moduleRequiresAdvancedCaseSearch)) {
		// Advanced search is registered as a child of Simple Case Search in HQ.
		ids.add("case-search");
		ids.add("advanced-case-search");
	}
	if (doc.connectType !== null) ids.add("commcare-connect");

	return HQ_FEATURE_FLAG_REQUIREMENTS.filter((flag) => ids.has(flag.id));
}

/** Report for a downloaded artifact, whose eventual HQ domain is unknown. */
export function featureFlagReportForDownload(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagReport {
	return featureFlagReportForUnverifiedRequirements(
		requiredHqFeatureFlags(doc),
	);
}
