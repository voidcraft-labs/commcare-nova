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
	caseListColumnTextShows,
	effectiveCaseSearchConfig,
	type Field,
	isCaptureField,
	type Module,
	noMatchesFormOf,
	searchInputDefault,
	tileCellFor,
} from "@/lib/domain";
import { walkExpressionTerms } from "@/lib/domain/expression/walk";
import {
	type ProjectSpaceAdvisoryUse,
	type ProjectSpaceCapabilityUse,
	type ProjectSpaceCompatibilityReport,
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
	projectSpaceCompatibilityForUnknownTarget,
} from "@/lib/publish/projectSpaceCompatibility";
import { hostLowersNoMatchesForm } from "./emissionPlan";
import { moduleExpressionContexts } from "./expressionContext";
import {
	caseListStepDatumId,
	moduleCaseTypeForActions,
	parentSelectModuleUuid,
} from "./formLinkProjection";
import { moduleIsSearchFirst } from "./suite/case-search/inlineSearch";
import { searchNeedsSupportingCases } from "./suite/case-search/relatedCaseProjection";
import {
	searchInputIsSingleDate,
	searchInputSuppressesAutoMatch,
} from "./suite/case-search/searchPrompts";
import { xpathQueryUsesRelatedLookup } from "./suite/case-search/xpathQuery";
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
	| "large-search-performance"
	| "related-case-lookups"
	| "case-tiles"
	| "custom-case-tiles";

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
	"related-case-lookups": "CASE_SEARCH_RELATED_LOOKUPS",
	"case-tiles": "CASE_LIST_TILE",
	"custom-case-tiles": "CASE_LIST_TILE_CUSTOM",
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
 * Why a module's effective Search needs HQ's advanced case search setting,
 * one reason per shape; empty where it needs none. Without the setting HQ
 * omits `<prompt default>` (`feature_support.py::enable_default_value_expression`),
 * and its Case List page offers none of the other shapes
 * (`templates/app_manager/partials/modules/bootstrap5/case_search_properties.html`,
 * `case_search_property.html`), so nobody could make or change them there.
 * A search's own filter (`_xpath_query`), the zero-input `match-all()`
 * included, adds nothing: HQ's Case List page offers and keeps a default
 * filter for every project space.
 */
export function advancedCaseSearchReasons(module: Module): string[] {
	if (effectiveCaseSearchConfig(module) === undefined) return [];
	const inputs = module.caseListConfig?.searchInputs ?? [];
	const reasons: string[] = [];
	if (inputs.some((input) => searchInputDefault(input) !== undefined)) {
		reasons.push("A Search field starts with a suggested value.");
	}
	if (inputs.some((input) => input.kind === "hidden")) {
		reasons.push(
			"A Search screen carries a hidden value worked out when it opens.",
		);
	}
	if (moduleIsSearchFirst(module)) {
		reasons.push("The menu opens on Search.");
	}
	if (inputs.some(searchInputIsSingleDate)) {
		reasons.push("A Search field takes one date.");
	}
	if (inputs.some(searchInputSuppressesAutoMatch)) {
		reasons.push("A Search field is matched by a rule Nova writes.");
	}
	return reasons;
}

/**
 * Why a module's effective Search needs HQ's related-case lookups, one
 * reason per arm; empty where it needs none. Without the setting HQ's case
 * search refuses a query that reads related cases
 * (`case_search/filter_dsl.py::_require_related_lookups_flag`), and HQ's
 * build adds such a query itself for a search-first menu that follows a
 * parent case chosen first
 * (`util.py::module_uses_inline_search_with_parent_relationship_parent_select`).
 */
function relatedCaseSearchReasons(doc: BlueprintDoc, module: Module): string[] {
	const list = module.caseListConfig;
	if (effectiveCaseSearchConfig(module) === undefined || list === undefined) {
		return [];
	}
	const expressions = moduleExpressionContexts(doc, module.uuid);
	const reasons: string[] = [];
	if (
		xpathQueryUsesRelatedLookup(
			list,
			module.caseType,
			expressions,
			caseListStepDatumId(doc, module.uuid),
		)
	) {
		reasons.push("A Search filter looks at related cases.");
	}
	if (searchNeedsSupportingCases(list, expressions)) {
		reasons.push("A case list shows values from related cases.");
	}
	if (
		moduleIsSearchFirst(module) &&
		parentSelectModuleUuid(doc, module.uuid) !== undefined
	) {
		reasons.push(
			"A menu that opens on Search follows a parent case chosen first.",
		);
	}
	return reasons;
}

/**
 * Whether a case list draws each case as a tile: some column has a cell,
 * the test the HQ JSON emitter makes before it writes `case_tile_template`.
 * Every Nova tile is `custom`, which HQ's Case List page offers and keeps
 * only under both tile settings
 * (`static/app_manager/js/details/bootstrap5/screen.js`).
 */
function moduleHasCaseTiles(module: Module): boolean {
	const list = module.caseListConfig;
	if (list?.tile === undefined) return false;
	return list.columns.some(
		(column) => tileCellFor(column, list.tile) !== undefined,
	);
}

/**
 * Whether a link a capture question saves on a case is shown on a screen:
 * a column of some module of that case type, shown on Results or Details,
 * reads the property, as a column of its own or inside a calculated
 * column's expression. HQ reads `VIEW_FORM_ATTACHMENT` only when someone
 * opens such a link (`reports/views.py::_can_view_form_attachment`), so a
 * link no screen shows asks nothing of the project space.
 */
export function linkWriteIsShown(doc: BlueprintDoc, field: Field): boolean {
	if (!isCaptureField(field) || field.caseWrite?.mode !== "url") return false;
	const { caseType, property } = field.caseWrite;
	return Object.values(doc.modules).some(
		(module) =>
			module.caseType === caseType &&
			(module.caseListConfig?.columns ?? []).some((column) => {
				if (!caseListColumnTextShows(column)) return false;
				if (column.kind !== "calculated") return column.field === property;
				let reads = false;
				walkExpressionTerms(column.expression, (term) => {
					if (
						term.kind === "prop" &&
						term.caseType === caseType &&
						term.property === property &&
						(term.via === undefined || term.via.kind === "self")
					) {
						reads = true;
					}
				});
				return reads;
			}),
	);
}

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
	doc: BlueprintDoc,
	module: Module,
): boolean {
	return (
		hostLowersNoMatchesForm(module) &&
		noMatchesFormOf(doc, module.uuid) !== undefined
	);
}

/** Semantic capabilities and private proof inputs required by this app. */
export function projectSpaceCompatibilityProbePlan(
	doc: BlueprintDoc,
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
		/* What HQ's editors offer only under a flag lands only where the
		 * module's search does: a module that has cases
		 * (`moduleCaseTypeForActions`, the gate `expandDoc` reads). */
		const searchLands = moduleCaseTypeForActions(doc, module.uuid) !== "";
		const advancedReasons = searchLands
			? advancedCaseSearchReasons(module)
			: [];
		if (advancedReasons.length > 0) advancedSearchRequired = true;
		for (const reason of advancedReasons) addReason("case-search", reason);
		for (const reason of searchLands
			? relatedCaseSearchReasons(doc, module)
			: []) {
			addReason("related-case-search", reason);
		}
		if (moduleRequiresNoMatchesRegistration(doc, module)) {
			addReason(
				"registration-after-empty-search",
				"A search that finds nothing offers to register a new case.",
			);
		}
	}

	for (const module of Object.values(doc.modules)) {
		/* A case list reaches HQ only for a module that has cases: one with
		 * a case type and a form that is not a survey, or a case list alone
		 * (`moduleCaseTypeForActions`, the gate `expandDoc` reads). */
		if (moduleCaseTypeForActions(doc, module.uuid) === "") continue;
		if (module.caseListConfig?.selection?.kind === "multiple") {
			addReason(
				"multi-select-case-lists",
				"A case list lets workers choose several cases.",
			);
		}
		if (moduleHasCaseTiles(module)) {
			addReason("case-tiles", "A case list is laid out as tiles.");
		}
	}

	for (const field of Object.values(doc.fields)) {
		if (!isCaptureField(field) || field.caseWrite === undefined) continue;
		if (field.caseWrite.mode === "attachment") {
			addReason(
				"case-attachments",
				"A capture question saves its file on the case.",
			);
		} else if (linkWriteIsShown(doc, field)) {
			addReason(
				"attachment-links",
				"A case list or its details show a link to a captured file.",
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

	for (const [capability, flags] of [
		["multi-select-case-lists", ["advanced-case-search"]],
		["related-case-search", ["related-case-lookups"]],
		["case-tiles", ["case-tiles", "custom-case-tiles"]],
		["commcare-connect", ["commcare-connect"]],
		["case-attachments", ["case-attachments"]],
		["attachment-links", ["attachment-links"]],
	] as const) {
		const reasons = reasonsByCapability.get(capability);
		if (!reasons) continue;
		capabilities.push({
			capability: projectSpaceCapabilityUse(capability, [...reasons]),
			featureFlags: flags.map((flag) => HQ_PRIVATE_FEATURE_FLAGS[flag]),
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
	doc: BlueprintDoc,
): ProjectSpaceCapabilityUse[] {
	return projectSpaceCompatibilityProbePlan(doc).capabilities.map(
		(plan) => plan.capability,
	);
}

export function projectSpaceCompatibilityForDownload(
	doc: BlueprintDoc,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"download",
	);
}

export function projectSpaceCompatibilityForPrepublish(
	doc: BlueprintDoc,
): ProjectSpaceCompatibilityReport {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	return projectSpaceCompatibilityForUnknownTarget(
		plan.capabilities.map((item) => item.capability),
		plan.advisories.map((item) => item.advisory),
		"prepublish",
	);
}
