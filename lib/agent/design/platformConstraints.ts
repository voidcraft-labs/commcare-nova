/**
 * The closed platform-constraint vocabulary — the catalogued codes a source
 * claim, review finding, or design blocker may cite when its basis is a Nova or
 * CommCare platform fact rather than user evidence.
 *
 * Dependency-free leaf on purpose: the graph validator (`graph.ts`), the
 * review grounding rules (`review.ts`), and the capability catalog
 * (`capabilityCatalog.ts`) all consume this one set, and the validator must
 * not drag the tool registry into its import graph to know which codes exist.
 *
 * Each entry is a bounded, present-tense statement plus a stable repository
 * anchor (`file::symbol` or a doc path — never line numbers). `gapUnitFile`
 * marks a deliberate target gap from the complex-app program: the code stands
 * exactly as long as its unit file remains under `docs/plans/complex-app/`,
 * and the catalog source test fails when a unit ships (its file disappears)
 * without this vocabulary shedding the code.
 *
 * Adding a code here is a reviewed act: it becomes citable grounding for a
 * CRITICAL finding (`review.ts::validateFindingEvidence`), so a wrong entry
 * lets the reviewer block designs on a fact Nova does not actually have.
 */

export const PLATFORM_CONSTRAINT_CODES = [
	// Preview / runtime limitations
	"PREVIEW_AUTOMATIONS_NOT_EXECUTED",
	"NO_MATCHES_REGISTRATION_IS_WEB_APPS_ONLY",
	// External setup requirements
	"AUTOMATION_HQ_MANUAL_SETUP",
	"HQ_BUILD_RELEASE_NOT_API_DRIVEN",
	// Deployment / HQ export closures
	"WORKER_SCHEMA_AND_ROLES_NOT_PUSHED",
	"LOCATION_OWNER_EXPORT_CLOSED",
	// Case / data shape rules
	"CASE_SEARCH_IS_LIVE_AND_ONLINE",
	"CASE_STATUS_IS_OPEN_OR_CLOSED",
	"CASE_UPDATES_ARE_NOT_COMPARE_AND_SET",
	"SINGLE_DIRECT_CASE_WRITE_PER_FIELD",
	"STANDARD_SCALAR_WRITERS_LIMITED",
	"CASE_NAME_REQUIRED_ON_CREATE",
	"REGISTRATION_CREATE_IS_UNCONDITIONAL",
	"RESERVED_CASE_IDENTIFIERS_REJECTED",
	"CASE_WRITE_TARGETS_MODULE_LINEAGE",
	"CASE_PROPERTY_CLEAR_UNAVAILABLE",
	"CASE_BOUND_UPDATE_INPUTS_EDIT_CURRENT_VALUES",
	"SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET",
	"DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS",
	"ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY",
	// Deliberate target gaps (one per remaining complex-app unit)
	"GAP_SESSION_ENDPOINTS_DEEP_LINKS",
] as const;

export type PlatformConstraintCode = (typeof PLATFORM_CONSTRAINT_CODES)[number];

export interface PlatformConstraint {
	readonly code: PlatformConstraintCode;
	/** Present-tense statement of the constraint, in Nova vocabulary. */
	readonly statement: string;
	/** Stable repository anchor stating the constraint (`file::symbol` or a
	 * doc path). */
	readonly sourceAnchor: string;
	/** For deliberate target gaps: the complex-app unit file whose existence
	 * keeps this code alive. */
	readonly gapUnitFile?: string;
}

export const PLATFORM_CONSTRAINTS: Record<
	PlatformConstraintCode,
	PlatformConstraint
> = {
	PREVIEW_AUTOMATIONS_NOT_EXECUTED: {
		code: "PREVIEW_AUTOMATIONS_NOT_EXECUTED",
		statement:
			"Preview shows a read-only current-match count for an automation; it never updates a case, sends a message, or advances a schedule, and current matching does not predict CommCare HQ's next sweep.",
		sourceAnchor: "docs/plans/complex-app-plan.md#what-is-built",
	},
	NO_MATCHES_REGISTRATION_IS_WEB_APPS_ONLY: {
		code: "NO_MATCHES_REGISTRATION_IS_WEB_APPS_ONLY",
		statement:
			"A search-first module's registration form offered after a search finds no matches, and the search answers it carries into that form, work in the browser app only: a phone never shows a case list for an empty search response and passes no search answers to a form, so workers on Android cannot register from an empty search and must reach registration another way.",
		sourceAnchor: "lib/commcare/suite/case-search/noMatches.ts",
	},
	AUTOMATION_HQ_MANUAL_SETUP: {
		code: "AUTOMATION_HQ_MANUAL_SETUP",
		statement:
			"CommCare HQ has no REST resource for automatic case updates or conditional alerts; an automation ships as a regenerated human-applied HQ setup guide, and publishing an app does not install or alter any HQ rule.",
		sourceAnchor: "lib/agent/tools/automations.ts",
	},
	HQ_BUILD_RELEASE_NOT_API_DRIVEN: {
		code: "HQ_BUILD_RELEASE_NOT_API_DRIVEN",
		statement:
			"Nova drives HQ upload with an API key but cannot build or release an app remotely; the deployment lifecycle's built/released/runnable phases are observed, and a person completes them in CommCare HQ.",
		sourceAnchor: "lib/deployment/CLAUDE.md",
	},
	WORKER_SCHEMA_AND_ROLES_NOT_PUSHED: {
		code: "WORKER_SCHEMA_AND_ROLES_NOT_PUSHED",
		statement:
			"An explicit provisioning call creates mobile workers on a project space, carrying each persona's worker information and place assignment; the domain's user-data field definition and its user roles have no REST resource, so they stay a setup instruction, and a persona is never a Nova account.",
		sourceAnchor: "lib/deployment/workers.ts",
	},
	LOCATION_OWNER_EXPORT_CLOSED: {
		code: "LOCATION_OWNER_EXPORT_CLOSED",
		statement:
			"Typed location-based case ownership executes in Preview and publishing puts an app's places on the target project space. An owner set to a place beneath the current case owner exports on every mode, emitting level codes and the case's own owner_id; an owner set to one particular place is refused on every mode, because the compiler emits Nova's own place UUID and no compile path resolves it through the deployment's location mappings.",
		sourceAnchor: "docs/plans/complex-app-plan.md#what-is-built",
	},
	CASE_SEARCH_IS_LIVE_AND_ONLINE: {
		code: "CASE_SEARCH_IS_LIVE_AND_ONLINE",
		statement:
			"Case search queries the server live: a Web Apps user is connected anyway, but on mobile a search (and the claim that follows selecting a result) fails without connectivity, so an offline-first design must not gate its primary workflow behind case search.",
		sourceAnchor: "lib/commcare/suite/case-search/remoteRequest.ts",
	},
	CASE_STATUS_IS_OPEN_OR_CLOSED: {
		code: "CASE_STATUS_IS_OPEN_OR_CLOSED",
		statement:
			"The built-in case status has exactly two values: open and closed. New cases are open, and ordinary case lists already exclude closed cases. Treat an active case as open; program-specific states such as pending, enrolled, or inactive belong in a separate declared property.",
		sourceAnchor:
			"lib/domain/standardCaseProperties.ts::CANONICAL_STANDARD_CASE_PROPERTY_LABELS",
	},
	CASE_UPDATES_ARE_NOT_COMPARE_AND_SET: {
		code: "CASE_UPDATES_ARE_NOT_COMPARE_AND_SET",
		statement:
			"A form decides whether to include a case operation using the case state loaded into that form. CommCare HQ receives only the resulting case update, not the condition, and applies it without comparing the condition to current server state. An app-only claim can hide later work after sync but cannot guarantee one winner when two users submit from the same prior state; a design requiring exclusive concurrent claiming needs a server endpoint or must disclose that limitation.",
		sourceAnchor: "lib/commcare/xform/caseOps.ts::buildCaseOperations",
	},
	SINGLE_DIRECT_CASE_WRITE_PER_FIELD: {
		code: "SINGLE_DIRECT_CASE_WRITE_PER_FIELD",
		statement:
			"A visible field carries at most one direct case-write destination; a value that must land in several case properties needs a calculated writer per additional destination.",
		sourceAnchor: "lib/domain/fields/base.ts",
	},
	STANDARD_SCALAR_WRITERS_LIMITED: {
		code: "STANDARD_SCALAR_WRITERS_LIMITED",
		statement:
			"case_name and external_id are the only standard scalar destinations a field writer may target; other reserved or system case names are rejected at authoring.",
		sourceAnchor: "lib/commcare/caseWriteAdmission.ts",
	},
	CASE_NAME_REQUIRED_ON_CREATE: {
		code: "CASE_NAME_REQUIRED_ON_CREATE",
		statement:
			"A registration form or child-create bucket requires exactly one case_name writer; a create without a name is not constructible.",
		sourceAnchor:
			"lib/commcare/caseWriteAdmission.ts::assertAndProjectCaseWriteInventory",
	},
	REGISTRATION_CREATE_IS_UNCONDITIONAL: {
		code: "REGISTRATION_CREATE_IS_UNCONDITIONAL",
		statement:
			"Submitting a registration form always creates its hosted record. A workflow that must submit successfully while conditionally skipping that create uses a standalone form with a conditional create operation; validation is the alternative only when the ineligible submission itself must be blocked.",
		sourceAnchor: "lib/commcare/formActions.ts::buildFormActions",
	},
	RESERVED_CASE_IDENTIFIERS_REJECTED: {
		code: "RESERVED_CASE_IDENTIFIERS_REJECTED",
		statement:
			"Platform-owned case types and reserved write properties (CommCare's reserved words plus name, owner_id, location_id, hq_user_id, external_id, category, state) are rejected as authored write targets.",
		sourceAnchor: "lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES",
	},
	CASE_WRITE_TARGETS_MODULE_LINEAGE: {
		code: "CASE_WRITE_TARGETS_MODULE_LINEAGE",
		statement:
			"A form's writable case destination is exactly the module's own case type, a declared child type whose parent_type is that module type, or the worker's own record; sibling, grandchild, and unrelated types are not writable from that form. The worker's own record takes caseType 'commcare-user' and a property that is a DECLARED worker property's slug, is available on any form including a survey, and cannot be written from inside a repeat; the built-in worker fields (username, first_name, last_name, language, phone_number, hq_user_id, case_name, and the commcare_* keys) are kept in step with the worker's profile and are not writable.",
		sourceAnchor: "lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory",
	},
	CASE_PROPERTY_CLEAR_UNAVAILABLE: {
		code: "CASE_PROPERTY_CLEAR_UNAVAILABLE",
		statement:
			"A case-property operation can write a typed value or use a condition to skip that write; Nova cannot explicitly clear an existing property. When status or closure removes a record from active work, preserve an earlier scheduling or detail value as history unless the request specifically requires erasure, in which case the design must surface the platform gap rather than inventing a blank or null write.",
		sourceAnchor:
			"lib/domain/predicate/typeChecker.ts::checkValueAssignmentExpression",
	},
	CASE_BOUND_UPDATE_INPUTS_EDIT_CURRENT_VALUES: {
		code: "CASE_BOUND_UPDATE_INPUTS_EDIT_CURRENT_VALUES",
		statement:
			"In a selected-record or close form, a visible input that writes directly to the selected record opens with that property's current saved value. Leaving it untouched preserves the value; clearing it is an edit. A blank replacement input that conditionally skips its write is a separate interaction and should be designed only when the workflow genuinely needs sparse replacement.",
		sourceAnchor: "lib/preview/engine/formEngine.ts::preloadCaseData",
	},
	SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET: {
		code: "SEVERAL_CASE_FORMS_SHARE_ONE_ANSWER_SET",
		statement:
			"A several-case follow-up or close form uses one shared answer set for the complete ordered selection. Primary case-update inputs start blank instead of choosing one case's current value; each nonblank answer is saved to every selected case, while a blank answer preserves each case's existing value. The form cannot collect a different answer for each selected case.",
		sourceAnchor: "lib/preview/engine/formEngine.ts::FormEngine",
	},
	DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS: {
		code: "DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS",
		statement:
			"Display conditions, including conditions over worker properties, are the supported in-app role and navigation gate. They do not decide which cases a worker restores or which cases live search can return, so a role-safe design pairs those gates with the intended ownership or location model and with search filters that enforce the same boundary; remote search may reach beyond assigned restore ownership when its query permits it. A remote case-search comparison must be anchored to a case property, so different role populations normally use separate role-gated navigation entries over the same case type, each with its own case-property filter, rather than a standalone worker-role clause inside one shared query.",
		sourceAnchor: "docs/research/advanced-case-actions.md::2.1-2.4",
	},
	ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY: {
		code: "ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY",
		statement:
			"On-device date arithmetic can faithfully add fixed seconds through weeks to a date. Calendar-relative months or years, and date-add over a datetime, are rejected because JavaRosa cannot preserve their semantics; a design that requires true calendar milestones must resolve that requirement instead of lowering it to hand-built leap-year arithmetic or an unstated day approximation.",
		sourceAnchor:
			"lib/commcare/expression/onDeviceCompatibility.ts::onDeviceDateAddIssue",
	},
	GAP_SESSION_ENDPOINTS_DEEP_LINKS: {
		code: "GAP_SESSION_ENDPOINTS_DEEP_LINKS",
		statement:
			"Session endpoints and shareable deep links resolved against the selected HQ server are a deliberate target gap.",
		sourceAnchor: "docs/plans/complex-app/session-endpoints-and-deep-links.md",
		gapUnitFile: "session-endpoints-and-deep-links.md",
	},
};
