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
	// External setup requirements
	"AUTOMATION_HQ_MANUAL_SETUP",
	"HQ_BUILD_RELEASE_NOT_API_DRIVEN",
	// Deployment / HQ export closures
	"LOOKUP_HQ_EXPORT_CLOSED",
	"WORKER_PROVISIONING_NOT_SHIPPED",
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
	"DISPLAY_CONDITIONS_ARE_UX_NOT_ACCESS",
	"ON_DEVICE_DATE_ADD_FIXED_DURATION_ONLY",
	// Deliberate target gaps (one per remaining complex-app unit)
	"GAP_CASE_ATTACHMENT_EMISSION",
	"GAP_USERCASE_OWNER_SETS",
	"GAP_PUSH_PROVISIONING_DRIVERS",
	"GAP_APP_SETUP_UI",
	"GAP_FORM_LINKS_AND_SECTIONS",
	"GAP_NESTED_MENUS",
	"GAP_SESSION_ENDPOINTS_DEEP_LINKS",
	"GAP_MULTI_SELECT_RELATED_CASES",
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
	LOOKUP_HQ_EXPORT_CLOSED: {
		code: "LOOKUP_HQ_EXPORT_CLOSED",
		statement:
			"An app referencing lookup tables exports as a local .ccz with embedded fixture bytes only; direct HQ JSON and HQ upload modes refuse a lookup-carrying document until the resource-push driver ships.",
		sourceAnchor: "lib/export/boundaryValidation.ts",
	},
	WORKER_PROVISIONING_NOT_SHIPPED: {
		code: "WORKER_PROVISIONING_NOT_SHIPPED",
		statement:
			"User properties, user types, and personas are Nova authoring and Preview state; export and HQ upload configure no HQ user-data schema, role, or worker account until the provisioning driver ships.",
		sourceAnchor: "lib/domain/users.ts",
	},
	LOCATION_OWNER_EXPORT_CLOSED: {
		code: "LOCATION_OWNER_EXPORT_CLOSED",
		statement:
			"Typed location-based case ownership executes in Preview, but every export mode for it stays closed until the usercase/deployment work ships the persona-scoped locations fixture and HQ identity mapping.",
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
			"A form's writable case destination is exactly the module's own case type or a declared child type whose parent_type is that module type; sibling, grandchild, and unrelated types are not writable from that form.",
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
	GAP_CASE_ATTACHMENT_EMISSION: {
		code: "GAP_CASE_ATTACHMENT_EMISSION",
		statement:
			"Save-to-case attachment emission and attachment-link presentation are a deliberate target gap; a captured photo saves with the submission but cannot be attached to a case or linked from a case list yet.",
		sourceAnchor: "docs/plans/complex-app/attachment-emission-and-link-ux.md",
		gapUnitFile: "attachment-emission-and-link-ux.md",
	},
	GAP_USERCASE_OWNER_SETS: {
		code: "GAP_USERCASE_OWNER_SETS",
		statement:
			"Usercase materialization, owner-set derivation, tenant-complete restore closure, and the flat location fixture are a deliberate target gap.",
		sourceAnchor: "docs/plans/complex-app/usercase-owner-sets-and-wire.md",
		gapUnitFile: "usercase-owner-sets-and-wire.md",
	},
	GAP_PUSH_PROVISIONING_DRIVERS: {
		code: "GAP_PUSH_PROVISIONING_DRIVERS",
		statement:
			"Referenced-table push, location push, and explicit worker provisioning against a deployment's ownership mappings are a deliberate target gap; nothing pushes those resources to HQ yet.",
		sourceAnchor: "docs/plans/complex-app/push-and-provisioning-drivers.md",
		gapUnitFile: "push-and-provisioning-drivers.md",
	},
	GAP_APP_SETUP_UI: {
		code: "GAP_APP_SETUP_UI",
		statement:
			"The App setup workspace's remaining Deployment section, and the SA/MCP/docs surfaces for the outstanding deployment-chain units, are a deliberate target gap.",
		sourceAnchor: "docs/plans/complex-app/app-setup-ui-sa-mcp-and-docs.md",
		gapUnitFile: "app-setup-ui-sa-mcp-and-docs.md",
	},
	GAP_FORM_LINKS_AND_SECTIONS: {
		code: "GAP_FORM_LINKS_AND_SECTIONS",
		statement:
			"End-of-form links (exhaustive-else link projection) and authored FormSection pages are a deliberate target gap; a form cannot chain to another form or present page navigation yet. Ordinary group fields still provide visual grouping within one continuous form and are not part of this gap.",
		sourceAnchor: "docs/plans/complex-app/form-links-and-sections.md",
		gapUnitFile: "form-links-and-sections.md",
	},
	GAP_NESTED_MENUS: {
		code: "GAP_NESTED_MENUS",
		statement:
			"One-tier menu nesting and native linked-form reuse are a deliberate target gap; navigation is a flat module list until that unit ships.",
		sourceAnchor:
			"docs/plans/complex-app/nested-menus-and-linked-form-reuse.md",
		gapUnitFile: "nested-menus-and-linked-form-reuse.md",
	},
	GAP_SESSION_ENDPOINTS_DEEP_LINKS: {
		code: "GAP_SESSION_ENDPOINTS_DEEP_LINKS",
		statement:
			"Session endpoints and shareable deep links resolved against the selected HQ server are a deliberate target gap.",
		sourceAnchor: "docs/plans/complex-app/session-endpoints-and-deep-links.md",
		gapUnitFile: "session-endpoints-and-deep-links.md",
	},
	GAP_MULTI_SELECT_RELATED_CASES: {
		code: "GAP_MULTI_SELECT_RELATED_CASES",
		statement:
			"Multi-select case lists, related-case display, and authorable profile extensions are a deliberate target gap.",
		sourceAnchor:
			"docs/plans/complex-app/multi-select-related-cases-and-profile.md",
		gapUnitFile: "multi-select-related-cases-and-profile.md",
	},
};
