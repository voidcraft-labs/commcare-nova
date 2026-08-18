/**
 * CommCare HQ feature-flag requirements for wire features Commcare Nova emits.
 *
 * The JSON manifest is the lifecycle source of truth. The client-safe public
 * catalog/report vocabulary lives in `lib/publish/hqFeatureFlags.ts`; this
 * emission-boundary module owns only the exact BlueprintDoc → required-flags
 * projection because it depends on CommCare wire decisions.
 */

import {
	type BlueprintDoc,
	CONNECT_TYPE_LABELS,
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
 * Nova projects into `_xpath_query` and prompt defaults. Ordinary Results
 * ordering lives in `case_details.short.sort_elements`, outside this toggle.
 * `excludedOwnerIds` and Search-action display copy deliberately do not count:
 * current HQ emits those without consulting CASE_SEARCH_ADVANCED.
 */
function moduleRequiresAdvancedCaseSearch(module: Module): boolean {
	if (effectiveCaseSearchConfig(module) === undefined) return false;
	const list = module.caseListConfig;
	if (!list) return false;
	if (list.filter !== undefined) return true;
	// HQ JSON preserves a deliberate zero-input Search action with a neutral
	// `_xpath_query = 'match-all()'` default property. HQ checks every
	// `_xpath_query` criterion against CASE_SEARCH_ADVANCED, including this
	// identity query.
	if (list.searchInputs.length === 0) return true;

	return list.searchInputs.some((input) => {
		if (input.kind === "advanced") return true;
		if ("default" in input && input.default !== undefined) return true;
		return simpleArmNeedsXPathQueryEmission(input);
	});
}

/** One app-specific use of a catalog requirement. The requirement stays the
 * canonical public object; reasons explain which authored settings in this
 * blueprint caused it to be selected. */
export interface HqFeatureFlagUse {
	readonly requirement: HqFeatureFlagRequirement;
	readonly reasons: readonly string[];
}

function advancedCaseSearchReasons(module: Module): string[] {
	if (!moduleRequiresAdvancedCaseSearch(module)) return [];
	const list = module.caseListConfig;
	if (!list) return [];
	const prefix = `The “${module.name}” module`;
	const reasons: string[] = [];

	if (list.filter !== undefined) {
		reasons.push(`${prefix} filters case-search results.`);
	}
	if (list.searchInputs.length === 0) {
		reasons.push(`${prefix} opens Search without asking for any inputs.`);
	}
	if (list.searchInputs.some((input) => input.kind === "advanced")) {
		reasons.push(`${prefix} uses an advanced Search input.`);
	}
	if (
		list.searchInputs.some(
			(input) => "default" in input && input.default !== undefined,
		)
	) {
		reasons.push(`${prefix} supplies a default value for a Search input.`);
	}
	if (
		list.searchInputs.some(
			(input) =>
				input.kind === "simple" && simpleArmNeedsXPathQueryEmission(input),
		)
	) {
		reasons.push(
			`${prefix} uses a Search input whose matching behavior needs Advanced Case Search.`,
		);
	}

	return reasons.length > 0
		? reasons
		: [`${prefix} uses behavior that is emitted through Advanced Case Search.`];
}

/**
 * Exact, ordered HQ feature-flag requirements plus the authored settings that
 * make each one relevant to this blueprint. Keeping the explanation beside
 * the detector prevents an MCP consumer from trying to reverse-engineer the
 * wire rules or presenting every catalog entry as applicable.
 */
export function requiredHqFeatureFlagUses(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagUse[] {
	const reasonsById = new Map<HqFeatureFlagId, Set<string>>();
	const addReason = (id: HqFeatureFlagId, reason: string): void => {
		const reasons = reasonsById.get(id) ?? new Set<string>();
		reasons.add(reason);
		reasonsById.set(id, reasons);
	};

	for (const module of Object.values(doc.modules)) {
		if (effectiveCaseSearchConfig(module) !== undefined) {
			addReason(
				"case-search",
				`The “${module.name}” module has a Case Search action or Search inputs.`,
			);
		}
		for (const reason of advancedCaseSearchReasons(module)) {
			// Advanced Case Search is an HQ child toggle, so the base flag has
			// already been recorded by the effective Search check above.
			addReason("advanced-case-search", reason);
		}
	}

	if (doc.connectType !== null) {
		addReason(
			"commcare-connect",
			`The app is configured for CommCare Connect ${CONNECT_TYPE_LABELS[doc.connectType]}.`,
		);
	}

	return HQ_FEATURE_FLAG_REQUIREMENTS.flatMap((requirement) => {
		const reasons = reasonsById.get(requirement.id);
		return reasons
			? [{ requirement, reasons: [...reasons] } satisfies HqFeatureFlagUse]
			: [];
	});
}

/** Exact, ordered set of HQ feature flags needed by this blueprint. */
export function requiredHqFeatureFlags(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagRequirement[] {
	return requiredHqFeatureFlagUses(doc).map((use) => use.requirement);
}

/** Report for a downloaded artifact, whose eventual HQ domain is unknown. */
export function featureFlagReportForDownload(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagReport {
	return featureFlagReportForUnverifiedRequirements(
		requiredHqFeatureFlags(doc),
	);
}

/** Report shown before any publish action. The app requirements are exact,
 * while domain state is deliberately unknown until a direct HQ upload can
 * probe its selected destination. */
export function featureFlagReportForPrepublish(
	doc: Pick<BlueprintDoc, "connectType" | "modules">,
): HqFeatureFlagReport {
	return featureFlagReportForUnverifiedRequirements(
		requiredHqFeatureFlags(doc),
		"prepublish",
	);
}
