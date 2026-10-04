/**
 * BlueprintDoc → CommCare HQ project-space compatibility projection.
 *
 * Public consumers see only semantic capabilities from `lib/publish`. This
 * emission-boundary module is the private join between those capabilities and
 * the exact HQ settings/runtime probes that establish them.
 */

import {
	type BlueprintDoc,
	CONNECT_TYPE_LABELS,
	effectiveCaseSearchConfig,
	isCaptureField,
	type Module,
	noMatchesFormOf,
	searchInputDefault,
} from "@/lib/domain";
import {
	type ProjectSpaceAdvisoryUse,
	type ProjectSpaceCapabilityUse,
	type ProjectSpaceCompatibilityReport,
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForUnknownTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { hostLowersNoMatchesForm } from "./emissionPlan";
import { domainFeatureFlag } from "./surface/gates";

export * from "@/lib/publish/projectSpaceCompatibility";

export type HqPrivateFeatureFlagId =
	| "deep-links"
	| "case-search-base"
	| "advanced-case-search"
	| "commcare-connect"
	| "case-attachments"
	| "attachment-links"
	| "no-matches-registration"
	| "large-search-performance";

/** Private input to the low-level HQ probe. Never serialize this object. */
export interface HqPrivateFeatureFlagRequirement {
	readonly id: HqPrivateFeatureFlagId;
	readonly slug: string;
	readonly namespace: "domain";
}

/**
 * The HQ toggle (`corehq/toggles/__init__.py`) behind each flag the probe
 * checks. Each flag's slug and namespace come from that toggle's gate entry.
 */
export const HQ_PRIVATE_FEATURE_FLAG_SYMBOLS = {
	"deep-links": "SESSION_ENDPOINTS",
	"case-search-base": "SYNC_SEARCH_CASE_CLAIM",
	"advanced-case-search": "CASE_SEARCH_ADVANCED",
	"commcare-connect": "COMMCARE_CONNECT",
	"case-attachments": "MM_CASE_PROPERTIES",
	"attachment-links": "VIEW_FORM_ATTACHMENT",
	"no-matches-registration": "FOLLOWUP_FORMS_AS_CASE_LIST_FORM",
	"large-search-performance": "CUSTOM_PROPERTIES",
} as const satisfies Record<HqPrivateFeatureFlagId, string>;

/* Resolved when the module loads, so a flag whose gate entry is missing or
 * cannot be probed fails every importer (and its tests) at once, rather than
 * only the compile or publish route whose document happens to need it. */
const HQ_PRIVATE_FEATURE_FLAGS = Object.fromEntries(
	(
		Object.entries(HQ_PRIVATE_FEATURE_FLAG_SYMBOLS) as [
			HqPrivateFeatureFlagId,
			string,
		][]
	).map(([id, symbol]) => {
		const flag = domainFeatureFlag(symbol);
		return [id, { id, slug: flag.slug, namespace: flag.namespace }];
	}),
) as Readonly<Record<HqPrivateFeatureFlagId, HqPrivateFeatureFlagRequirement>>;

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
 * Whether a module needs Search prompt starting values on an HQ-built suite.
 *
 * HQ always emits and executes `_xpath_query`, even without its private child
 * setting. The setting gates only `properties[].default_value` when HQ
 * regenerates `<prompt default>`, so no other Search behavior belongs here.
 */
/**
 * HQ writes `<prompt default>` only under its advanced case search setting
 * (`feature_support.py::enable_default_value_expression`). Two authored
 * shapes need that attribute: a visible Search field with a starting value,
 * and a hidden Search value, whose whole content IS the `default`.
 */
function moduleRequiresAdvancedCaseSearch(module: Module): boolean {
	if (effectiveCaseSearchConfig(module) === undefined) return false;
	return (
		module.caseListConfig?.searchInputs.some(
			(input) =>
				input.kind === "hidden" || searchInputDefault(input) !== undefined,
		) ?? false
	);
}

function advancedCaseSearchReasons(module: Module): string[] {
	if (!moduleRequiresAdvancedCaseSearch(module)) return [];
	const list = module.caseListConfig;
	if (!list) return [];
	const reasons: string[] = [];
	if (
		list.searchInputs.some((input) => searchInputDefault(input) !== undefined)
	) {
		reasons.push("A Search field starts with a suggested value.");
	}
	if (list.searchInputs.some((input) => input.kind === "hidden")) {
		reasons.push(
			"A Search screen carries a hidden value worked out when it opens.",
		);
	}
	return reasons;
}

type CompatibilityDoc = Pick<
	BlueprintDoc,
	"automations" | "connectType" | "fields" | "forms" | "formOrder" | "modules"
>;

/**
 * Whether the module's Results offer a registration form after an empty
 * search. HQ emits the Register action's `relevant` only under its private
 * `followup_forms_as_case_list_form` setting
 * (`details.py::get_case_list_form_action`); without it the action shows on
 * every Results screen, so the setting is required, not advisory. The
 * predicate is the emitter's own lowering gate so the check and the wire
 * cannot disagree.
 */
function moduleRequiresNoMatchesRegistration(
	doc: CompatibilityDoc,
	module: Module,
): boolean {
	return (
		hostLowersNoMatchesForm(module) &&
		noMatchesFormOf(doc, module.uuid) !== undefined
	);
}

/** Semantic capabilities and private proof inputs required by this app. */
export function projectSpaceCompatibilityProbePlan(
	doc: CompatibilityDoc,
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
		if (moduleRequiresNoMatchesRegistration(doc, module)) {
			addReason(
				"registration-after-empty-search",
				"A search that finds nothing offers to register a new case.",
			);
		}
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
	if (
		Object.values(doc.modules).some(
			(module) => module.entryPoint || module.caseListEntryPoint,
		) ||
		Object.values(doc.forms).some((form) => form.entryPoint)
	) {
		capabilities.push({
			capability: projectSpaceCapabilityUse("deep-links", [
				"The app has named entry points for authenticated links.",
			]),
			featureFlags: [HQ_PRIVATE_FEATURE_FLAGS["deep-links"]],
			runtimeProbes: [],
		});
	}
	const searchReasons = reasonsByCapability.get("case-search");
	if (searchReasons) {
		capabilities.push({
			capability: projectSpaceCapabilityUse("case-search", [...searchReasons]),
			featureFlags: [
				HQ_PRIVATE_FEATURE_FLAGS["case-search-base"],
				...(advancedSearchRequired
					? [HQ_PRIVATE_FEATURE_FLAGS["advanced-case-search"]]
					: []),
			],
			runtimeProbes: ["case-search"],
		});
	}

	for (const [capability, flag] of [
		["commcare-connect", "commcare-connect"],
		["case-attachments", "case-attachments"],
		["attachment-links", "attachment-links"],
	] as const) {
		const reasons = reasonsByCapability.get(capability);
		if (!reasons) continue;
		capabilities.push({
			capability: projectSpaceCapabilityUse(capability, [...reasons]),
			featureFlags: [HQ_PRIVATE_FEATURE_FLAGS[flag]],
			runtimeProbes: [],
		});
	}
	const noMatchesReasons = reasonsByCapability.get(
		"registration-after-empty-search",
	);
	if (noMatchesReasons) {
		capabilities.push({
			capability: projectSpaceCapabilityUse("registration-after-empty-search", [
				...noMatchesReasons,
			]),
			featureFlags: [HQ_PRIVATE_FEATURE_FLAGS["no-matches-registration"]],
			runtimeProbes: [],
		});
	}

	const advisories: HqProjectSpaceAdvisoryProbePlan[] = searchReasons
		? [
				{
					advisory: projectSpaceAdvisoryUse("large-search-performance", [
						...searchReasons,
					]),
					featureFlags: [HQ_PRIVATE_FEATURE_FLAGS["large-search-performance"]],
					runtimeProbes: [],
				},
			]
		: [];

	return { capabilities, advisories };
}

export function requiredProjectSpaceCapabilities(
	doc: CompatibilityDoc,
): ProjectSpaceCapabilityUse[] {
	return projectSpaceCompatibilityProbePlan(doc).capabilities.map(
		(plan) => plan.capability,
	);
}

export function projectSpaceCompatibilityForDownload(
	doc: CompatibilityDoc,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"download",
	);
}

export function projectSpaceCompatibilityForPrepublish(
	doc: CompatibilityDoc,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"prepublish",
	);
}
