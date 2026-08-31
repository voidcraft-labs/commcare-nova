/**
 * BlueprintDoc → CommCare HQ project-space compatibility projection.
 *
 * Public consumers see only semantic capabilities from `lib/publish`. This
 * emission-boundary module is the private join between those capabilities and
 * the exact HQ settings/runtime probes that establish them.
 */

import manifest from "@/config/commcare-hq-feature-flags.json";
import {
	type BlueprintDoc,
	CONNECT_TYPE_LABELS,
	effectiveCaseSearchConfig,
	isCaptureField,
	type Module,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import {
	type ProjectSpaceAdvisoryUse,
	type ProjectSpaceCapabilityUse,
	type ProjectSpaceCompatibilityReport,
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForUnknownTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { simpleArmNeedsXPathQueryEmission } from "./suite/case-search/simpleArmDerivation";

export * from "@/lib/publish/projectSpaceCompatibility";

export type HqPrivateFeatureFlagId =
	| "case-search-base"
	| "advanced-case-search"
	| "commcare-connect"
	| "case-attachments"
	| "attachment-links"
	| "large-search-performance";

/** Private input to the low-level HQ probe. Never serialize this object. */
export interface HqPrivateFeatureFlagRequirement {
	readonly id: HqPrivateFeatureFlagId;
	readonly slug: string;
	readonly namespace: "domain";
}

export type HqProjectSpaceRuntimeProbe = "case-search";

export interface HqProjectSpaceCapabilityProbePlan {
	readonly capability: ProjectSpaceCapabilityUse;
	readonly featureFlags: readonly HqPrivateFeatureFlagRequirement[];
	readonly runtimeProbes: readonly HqProjectSpaceRuntimeProbe[];
}

export interface HqProjectSpaceAdvisoryProbePlan {
	readonly advisory: ProjectSpaceAdvisoryUse;
	readonly featureFlags: readonly HqPrivateFeatureFlagRequirement[];
	readonly runtimeProbes: readonly HqProjectSpaceRuntimeProbe[];
}

export interface HqProjectSpaceCompatibilityProbePlan {
	readonly capabilities: readonly HqProjectSpaceCapabilityProbePlan[];
	readonly advisories: readonly HqProjectSpaceAdvisoryProbePlan[];
}

/**
 * Whether a module crosses HQ's advanced Search boundary.
 *
 * The base Search runtime is always required for effective Search. The extra
 * private setting is applicable only when Nova emits `_xpath_query` behavior
 * or prompt defaults.
 */
function moduleRequiresAdvancedCaseSearch(module: Module): boolean {
	if (effectiveCaseSearchConfig(module) === undefined) return false;
	const list = module.caseListConfig;
	if (!list) return false;
	if (effectiveFilterForEmission(list.filter) !== undefined) return true;
	if (list.searchInputs.length === 0) return true;

	return list.searchInputs.some((input) => {
		if (input.kind === "advanced") return true;
		if ("default" in input && input.default !== undefined) return true;
		return simpleArmNeedsXPathQueryEmission(input);
	});
}

function advancedCaseSearchReasons(module: Module): string[] {
	if (!moduleRequiresAdvancedCaseSearch(module)) return [];
	const list = module.caseListConfig;
	if (!list) return [];
	const reasons: string[] = [];

	if (effectiveFilterForEmission(list.filter) !== undefined) {
		reasons.push("Search results use an app-defined filter.");
	}
	if (list.searchInputs.length === 0) {
		reasons.push("Search can open without asking for any inputs.");
	}
	if (list.searchInputs.some((input) => input.kind === "advanced")) {
		reasons.push("A Search input uses an app-defined condition.");
	}
	if (
		list.searchInputs.some(
			(input) => "default" in input && input.default !== undefined,
		)
	) {
		reasons.push("A Search input supplies a suggested value.");
	}
	if (
		list.searchInputs.some(
			(input) =>
				input.kind === "simple" && simpleArmNeedsXPathQueryEmission(input),
		)
	) {
		reasons.push("A Search input uses flexible matching.");
	}

	return reasons.length > 0
		? reasons
		: ["The app uses advanced Search behavior."];
}

/** Semantic capabilities and private proof inputs required by this app. */
export function projectSpaceCompatibilityProbePlan(
	doc: Pick<BlueprintDoc, "automations" | "connectType" | "fields" | "modules">,
): HqProjectSpaceCompatibilityProbePlan {
	const reasonsByCapability = new Map<string, Set<string>>();
	let advancedSearchRequired = false;
	const addReason = (id: string, reason: string): void => {
		const reasons = reasonsByCapability.get(id) ?? new Set<string>();
		reasons.add(reason);
		reasonsByCapability.set(id, reasons);
	};

	for (const module of Object.values(doc.modules)) {
		if (effectiveCaseSearchConfig(module) === undefined) continue;
		addReason(
			"case-search",
			"The app searches for cases that may not already be available.",
		);
		const advancedReasons = advancedCaseSearchReasons(module);
		if (advancedReasons.length > 0) advancedSearchRequired = true;
		for (const reason of advancedReasons) addReason("case-search", reason);
	}

	for (const field of Object.values(doc.fields)) {
		if (!isCaptureField(field) || field.caseWrite === undefined) continue;
		if (field.caseWrite.mode === "attachment") {
			addReason(
				"case-attachments",
				"A capture question saves its file on the case.",
			);
		} else {
			addReason(
				"attachment-links",
				"A capture question saves a link to its file on the case.",
			);
		}
	}

	const usesConnectAutomation = Object.values(doc.automations ?? {}).some(
		(automation) =>
			automation.kind === "conditional-alert" &&
			automation.schedule.events.some(
				(event) =>
					event.content.kind === "connect-message" ||
					event.content.kind === "connect-survey",
			),
	);
	if (doc.connectType !== null) {
		addReason(
			"commcare-connect",
			`The app uses CommCare Connect ${CONNECT_TYPE_LABELS[doc.connectType]}.`,
		);
	}
	if (usesConnectAutomation) {
		addReason(
			"commcare-connect",
			"An alert sends a CommCare Connect message or survey.",
		);
	}

	const capabilities: HqProjectSpaceCapabilityProbePlan[] = [];
	const searchReasons = reasonsByCapability.get("case-search");
	if (searchReasons) {
		capabilities.push({
			capability: projectSpaceCapabilityUse("case-search", [...searchReasons]),
			featureFlags: [
				privateFeatureFlag("case-search-base"),
				...(advancedSearchRequired
					? [privateFeatureFlag("advanced-case-search")]
					: []),
			],
			runtimeProbes: ["case-search"],
		});
	}

	for (const id of [
		"commcare-connect",
		"case-attachments",
		"attachment-links",
	] as const) {
		const reasons = reasonsByCapability.get(id);
		if (!reasons) continue;
		capabilities.push({
			capability: projectSpaceCapabilityUse(id, [...reasons]),
			featureFlags: [privateFeatureFlag(id)],
			runtimeProbes: [],
		});
	}

	const advisories: HqProjectSpaceAdvisoryProbePlan[] = searchReasons
		? [
				{
					advisory: projectSpaceAdvisoryUse("large-search-performance", [
						...searchReasons,
					]),
					featureFlags: [privateFeatureFlag("large-search-performance")],
					runtimeProbes: [],
				},
			]
		: [];

	return { capabilities, advisories };
}

export function requiredProjectSpaceCapabilities(
	doc: Pick<BlueprintDoc, "automations" | "connectType" | "fields" | "modules">,
): ProjectSpaceCapabilityUse[] {
	return projectSpaceCompatibilityProbePlan(doc).capabilities.map(
		(plan) => plan.capability,
	);
}

export function projectSpaceCompatibilityForDownload(
	doc: Pick<BlueprintDoc, "automations" | "connectType" | "fields" | "modules">,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"download",
	);
}

export function projectSpaceCompatibilityForPrepublish(
	doc: Pick<BlueprintDoc, "automations" | "connectType" | "fields" | "modules">,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"prepublish",
	);
}

function privateFeatureFlag(
	id: HqPrivateFeatureFlagId,
): HqPrivateFeatureFlagRequirement {
	const flag = manifest.flags.find((candidate) => candidate.id === id);
	if (!flag) {
		throw new Error(`Missing private HQ compatibility probe: ${id}`);
	}
	if (
		flag.expectedNamespaces.length !== 1 ||
		flag.expectedNamespaces[0] !== "NAMESPACE_DOMAIN"
	) {
		throw new Error(`Unsafe private HQ compatibility probe namespace: ${id}`);
	}
	return {
		id,
		slug: flag.slug,
		/* The lifecycle audit proves this manifest row remains domain-scoped in
		 * upstream HQ. The runtime probe consumes the semantic namespace instead
		 * of leaking the upstream registry constant into its decision. */
		namespace: "domain",
	};
}
