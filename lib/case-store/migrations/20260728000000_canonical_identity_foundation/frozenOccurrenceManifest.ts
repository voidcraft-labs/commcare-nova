/**
 * Frozen occurrence manifest for the canonical authored-identity cutover.
 *
 * This is the one inventory shared by the advisory/locked scanner, repair
 * forensics, rehearsal, and migration. It deliberately contains no authored
 * production content. The entity paths are a frozen copy of the schema-derived
 * reference-slot registry at the cutover boundary; a steady-state parity test
 * proves that every live schema slot is represented without making this
 * historical migration import mutable domain schemas.
 */

import { FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS } from "./frozenRelationLifecycle";

export type FrozenOccurrenceDisposition =
	| "rewrite-current"
	| "block-current"
	| "archive-exact"
	| "opaque-pre-horizon"
	| "delete-operational"
	| "preserve-exact"
	| "DDL";

export type FrozenEntityKind =
	| "module"
	| "form"
	| "field"
	| "user_property"
	| "user_type"
	| "persona";

export type FrozenEntitySurface =
	| "xpath-ast"
	| "prose"
	| "predicate-ast"
	| "lookup-carrier"
	| "entity-uuid"
	| "case-property-ref"
	| "case-type-ref"
	| "identity"
	| "media"
	| "final-shape"
	| "standard-case-property"
	| "date-pattern"
	| "post-submit";

export interface FrozenEntityOccurrence {
	readonly id: string;
	readonly entity: FrozenEntityKind;
	readonly path: string;
	readonly surface: FrozenEntitySurface;
	readonly disposition: "rewrite-current" | "preserve-exact";
}

/**
 * All schema-owned reference and nested-identity locations inside one current
 * `blueprint_entities.data` value. A path uses `.` for object descent and
 * `[]` for array fan-out.
 */
export const FROZEN_ENTITY_OCCURRENCES = [
	// Every entity record embeds its row identity.
	{
		id: "entity.uuid",
		entity: "module",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "entity.uuid",
		entity: "form",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "entity.uuid",
		entity: "field",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "entity.uuid",
		entity: "user_property",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "entity.uuid",
		entity: "user_type",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "entity.uuid",
		entity: "persona",
		path: "uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},

	// Field XPath/template/lookup carriers.
	...[
		"relevant",
		"validate",
		"calculate",
		"default_value",
		"required",
		"repeat_count",
		"data_source.ids_query",
	].map(
		(path) =>
			({
				id: `field.${path}.xpath`,
				entity: "field",
				path,
				surface: "xpath-ast",
				disposition: "rewrite-current",
			}) as const,
	),
	...[
		"label",
		"hint",
		"help",
		"validate_msg",
		"optionsSource.options[].label",
	].map(
		(path) =>
			({
				id: `field.${path}.prose`,
				entity: "field",
				path,
				surface: "prose",
				disposition: "rewrite-current",
			}) as const,
	),
	{
		id: "field.optionsSource.lookup",
		entity: "field",
		path: "optionsSource",
		surface: "lookup-carrier",
		disposition: "rewrite-current",
	},
	{
		id: "field.case_property_on",
		entity: "field",
		path: "case_property_on",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "field.caseWrite.caseType",
		entity: "field",
		path: "caseWrite.caseType",
		surface: "case-type-ref",
		disposition: "preserve-exact",
	},
	{
		id: "field.caseWrite.property",
		entity: "field",
		path: "caseWrite.property",
		surface: "case-property-ref",
		disposition: "preserve-exact",
	},
	{
		id: "field.inline-option.uuid",
		entity: "field",
		path: "optionsSource.options[].uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	{
		id: "field.inline-option.media",
		entity: "field",
		path: "optionsSource.options[].media",
		surface: "media",
		disposition: "rewrite-current",
	},
	...["label_media", "hint_media", "help_media", "validate_msg_media"].map(
		(path) =>
			({
				id: `field.${path}.media`,
				entity: "field",
				path,
				surface: "media",
				disposition: "rewrite-current",
			}) as const,
	),

	// Form expression/reference/identity carriers.
	{
		id: "form.displayCondition",
		entity: "form",
		path: "displayCondition",
		surface: "predicate-ast",
		disposition: "rewrite-current",
	},
	{
		id: "form.connect.final-shape",
		entity: "form",
		path: "connect",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "form.postSubmit.final-shape",
		entity: "form",
		path: "postSubmit",
		surface: "post-submit",
		disposition: "rewrite-current",
	},
	{
		id: "form.formLinks.final-shape",
		entity: "form",
		path: "formLinks[]",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "form.caseOperations.final-shape",
		entity: "form",
		path: "caseOperations[]",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "form.closeCondition.field",
		entity: "form",
		path: "closeCondition.field",
		surface: "entity-uuid",
		disposition: "rewrite-current",
	},
	...[
		"formLinks[].condition",
		"formLinks[].datums[].xpath",
		"connect.assessment.user_score",
		"connect.deliver_unit.entity_id",
		"connect.deliver_unit.entity_name",
	].map(
		(path) =>
			({
				id: `form.${path}.xpath`,
				entity: "form",
				path,
				surface: "xpath-ast",
				disposition: "rewrite-current",
			}) as const,
	),
	{
		id: "form.formLinks.target",
		entity: "form",
		path: "formLinks[].target",
		surface: "entity-uuid",
		disposition: "rewrite-current",
	},
	...[
		"caseOperations[].target.expr",
		"caseOperations[].condition",
		"caseOperations[].name",
		"caseOperations[].owner",
		"caseOperations[].rename",
		"caseOperations[].writes[].value",
		"caseOperations[].writes[].condition",
		"caseOperations[].links[].target.expr",
	].map(
		(path) =>
			({
				id: `form.${path}.predicate`,
				entity: "form",
				path,
				surface: "predicate-ast",
				disposition: "rewrite-current",
			}) as const,
	),
	...[
		"caseOperations[].target.opUuid",
		"caseOperations[].target.idFrom",
		"caseOperations[].forEach.repeat",
		"caseOperations[].links[].target.opUuid",
		"caseOperations[].links[].target.idFrom",
	].map(
		(path) =>
			({
				id: `form.${path}.entity`,
				entity: "form",
				path,
				surface: "entity-uuid",
				disposition: "rewrite-current",
			}) as const,
	),
	{
		id: "form.caseOperations.uuid",
		entity: "form",
		path: "caseOperations[].uuid",
		surface: "identity",
		disposition: "rewrite-current",
	},
	...[
		"caseOperations[].caseType",
		"caseOperations[].retype",
		"caseOperations[].links[].targetType",
	].map(
		(path) =>
			({
				id: `form.${path}.case-type`,
				entity: "form",
				path,
				surface: "case-type-ref",
				disposition: "preserve-exact",
			}) as const,
	),
	{
		id: "form.caseOperations.writes.property",
		entity: "form",
		path: "caseOperations[].writes[].property",
		surface: "case-property-ref",
		disposition: "rewrite-current",
	},
	...["icon", "audioLabel"].map(
		(path) =>
			({
				id: `form.${path}.media`,
				entity: "form",
				path,
				surface: "media",
				disposition: "rewrite-current",
			}) as const,
	),

	// Module predicates, nested identities, and media.
	{
		id: "module.displayCondition",
		entity: "module",
		path: "displayCondition",
		surface: "predicate-ast",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseType",
		entity: "module",
		path: "caseType",
		surface: "case-type-ref",
		disposition: "preserve-exact",
	},
	{
		id: "module.caseListConfig.columns.final-shape",
		entity: "module",
		path: "caseListConfig.columns[]",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseListConfig.listColumnOrder.final-shape",
		entity: "module",
		path: "caseListConfig.listColumnOrder",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseListConfig.detailColumnOrder.final-shape",
		entity: "module",
		path: "caseListConfig.detailColumnOrder",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseListConfig.searchInputs.final-shape",
		entity: "module",
		path: "caseListConfig.searchInputs[]",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseSearchConfig.final-shape",
		entity: "module",
		path: "caseSearchConfig",
		surface: "final-shape",
		disposition: "rewrite-current",
	},
	{
		id: "module.caseListConfig.columns.date-pattern",
		entity: "module",
		path: "caseListConfig.columns[].pattern",
		surface: "date-pattern",
		disposition: "rewrite-current",
	},
	...[
		"caseListConfig.columns[].expression",
		"caseListConfig.filter",
		"caseListConfig.searchInputs[].via",
		"caseListConfig.searchInputs[].default",
		"caseListConfig.searchInputs[].predicate",
		"caseSearchConfig.searchButtonDisplayCondition",
		"caseSearchConfig.excludedOwnerIds",
	].map(
		(path) =>
			({
				id: `module.${path}.predicate`,
				entity: "module",
				path,
				surface: "predicate-ast",
				disposition: "rewrite-current",
			}) as const,
	),
	...[
		"caseListConfig.columns[].field",
		"caseListConfig.searchInputs[].property",
	].map(
		(path) =>
			({
				id: `module.${path}.case-property`,
				entity: "module",
				path,
				surface: "case-property-ref",
				disposition: "rewrite-current",
			}) as const,
	),
	...[
		"caseListConfig.columns[].uuid",
		"caseListConfig.searchInputs[].uuid",
	].map(
		(path) =>
			({
				id: `module.${path}.identity`,
				entity: "module",
				path,
				surface: "identity",
				disposition: "rewrite-current",
			}) as const,
	),
	...[
		"icon",
		"audioLabel",
		"caseListConfig.icon",
		"caseListConfig.audioLabel",
		"caseListConfig.columns[].mapping[].assetId",
	].map(
		(path) =>
			({
				id: `module.${path}.media`,
				entity: "module",
				path,
				surface: "media",
				disposition: "rewrite-current",
			}) as const,
	),

	// Flat user collections.
	{
		id: "persona.userTypeUuid",
		entity: "persona",
		path: "userTypeUuid",
		surface: "entity-uuid",
		disposition: "rewrite-current",
	},
] as const satisfies readonly FrozenEntityOccurrence[];

export interface FrozenRootOccurrence {
	readonly id: string;
	readonly path: string;
	readonly surface:
		| "scalar"
		| "case-catalog"
		| "media"
		| "membership"
		| "identity";
	readonly disposition: "rewrite-current" | "preserve-exact";
}

export const FROZEN_ROOT_OCCURRENCES = [
	{
		id: "root.appId",
		path: "appId",
		surface: "identity",
		disposition: "preserve-exact",
	},
	{
		id: "root.appName",
		path: "appName",
		surface: "scalar",
		disposition: "preserve-exact",
	},
	{
		id: "root.connectType",
		path: "connectType",
		surface: "scalar",
		disposition: "preserve-exact",
	},
	{
		id: "root.caseTypes",
		path: "caseTypes",
		surface: "case-catalog",
		disposition: "rewrite-current",
	},
	{
		id: "root.logo",
		path: "logo",
		surface: "media",
		disposition: "rewrite-current",
	},
	...[
		"moduleOrder",
		"formOrder",
		"fieldOrder",
		"userPropertyOrder",
		"userTypeOrder",
		"personaOrder",
	].map(
		(path) =>
			({
				id: `root.${path}`,
				path,
				surface: "membership",
				disposition: "preserve-exact",
			}) as const,
	),
] as const satisfies readonly FrozenRootOccurrence[];

export interface FrozenStorageOccurrence {
	readonly id: string;
	readonly table: string;
	readonly path: string;
	readonly disposition: FrozenOccurrenceDisposition;
	readonly semantic:
		| "current-blueprint"
		| "mutation"
		| "audit"
		| "attachment"
		| "operational"
		| "media"
		| "lookup"
		| "case-data"
		| "case-schema"
		| "fold-baseline"
		| "sql-authored-identity"
		| "tenancy";
}

/**
 * Database occurrences. Table locks, complete content digests, the scan report,
 * and migration actions are all projected from this list.
 */
export const FROZEN_STORAGE_OCCURRENCES = [
	{
		id: "apps.current",
		table: "apps",
		path: "app_name|connect_type|case_types|logo|mutation_seq",
		disposition: "rewrite-current",
		semantic: "current-blueprint",
	},
	{
		id: "apps.logo.sql",
		table: "apps",
		path: "logo",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "apps.project-tenancy",
		table: "apps",
		path: "id|project_id",
		disposition: "block-current",
		semantic: "tenancy",
	},
	{
		id: "blueprint_entities.current",
		table: "blueprint_entities",
		path: "uuid|kind|parent_uuid|ordinal|data",
		disposition: "rewrite-current",
		semantic: "current-blueprint",
	},
	{
		id: "blueprint_entities.identity.sql",
		table: "blueprint_entities",
		path: "uuid|parent_uuid",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "app_changes.before-new-horizon",
		table: "app_changes",
		path: "mutations",
		disposition: "opaque-pre-horizon",
		semantic: "mutation",
	},
	{
		id: "app_changes.new-horizon-and-suffix",
		table: "app_changes",
		path: "kind|mutations|from_project_id|to_project_id",
		disposition: "preserve-exact",
		semantic: "mutation",
	},
	{
		id: "app_change_fold_baselines.snapshot-and-ddl",
		table: "app_change_fold_baselines",
		path: "app_id|seq|project_id|snapshot|snapshot_digest|created_at",
		disposition: "DDL",
		semantic: "fold-baseline",
	},
	{
		id: "events.mutation",
		table: "events",
		path: "kind|event",
		disposition: "archive-exact",
		semantic: "audit",
	},
	{
		id: "events.conversation.attachments",
		table: "events",
		path: "event.payload.attachments[].assetId",
		disposition: "preserve-exact",
		semantic: "audit",
	},
	{
		id: "events.conversation.receipts",
		table: "events",
		path: "event.payload",
		disposition: "preserve-exact",
		semantic: "audit",
	},
	{
		id: "events.current-nonmutation",
		table: "events",
		path: "kind|event",
		disposition: "block-current",
		semantic: "audit",
	},
	{
		id: "threads.attachments",
		table: "threads",
		path: "messages[].metadata.attachments[].assetId",
		disposition: "rewrite-current",
		semantic: "attachment",
	},
	{
		id: "threads.active_stream",
		table: "threads",
		path: "active_stream_id|active_holder_nonce",
		disposition: "delete-operational",
		semantic: "operational",
	},
	{
		id: "chat_stream_chunks.all",
		table: "chat_stream_chunks",
		path: "*",
		disposition: "delete-operational",
		semantic: "operational",
	},
	{
		id: "presence.all",
		table: "presence",
		path: "*",
		disposition: "delete-operational",
		semantic: "operational",
	},
	{
		id: "media_assets.identity",
		table: "media_assets",
		path: "id",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "media_asset_refs.identity",
		table: "media_asset_refs",
		path: "project_id|app_id|asset_id",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "media_upload_aliases.identity",
		table: "media_upload_aliases",
		path: "attempt_asset_id|canonical_asset_id",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "lookup_tables.identity",
		table: "lookup_tables",
		path: "project_id|id",
		disposition: "preserve-exact",
		semantic: "lookup",
	},
	{
		id: "lookup_columns.identity",
		table: "lookup_columns",
		path: "project_id|table_id|id",
		disposition: "preserve-exact",
		semantic: "lookup",
	},
	{
		id: "lookup_rows.identity-and-values",
		table: "lookup_rows",
		path: "project_id|table_id|id|values.<LookupColumnId>",
		disposition: "preserve-exact",
		semantic: "lookup",
	},
	{
		id: "lookup_table_references.edges",
		table: "lookup_table_references",
		path: "project_id|table_id|app_id",
		disposition: "preserve-exact",
		semantic: "lookup",
	},
	{
		id: "lookup_column_references.edges",
		table: "lookup_column_references",
		path: "project_id|table_id|column_id|app_id",
		disposition: "preserve-exact",
		semantic: "lookup",
	},
	{
		id: "cases.standard-properties",
		table: "cases",
		path: "app_id|case_id|case_type|properties",
		disposition: "block-current",
		semantic: "case-data",
	},
	{
		id: "cases.project-tenancy",
		table: "cases",
		path: "app_id|case_id|project_id",
		disposition: "block-current",
		semantic: "tenancy",
	},
	{
		id: "cases.standard-scalar-projection",
		table: "cases",
		path: "app_id|case_id|case_type|case_name|opened_on|external_id|modified_on|owner_id|closed_on",
		disposition: "preserve-exact",
		semantic: "case-data",
	},
	{
		id: "parked_case_values.standard-properties",
		table: "parked_case_values",
		path: "app_id|case_id|case_type|property",
		disposition: "block-current",
		semantic: "case-data",
	},
	{
		id: "case_type_schemas.standard-properties",
		table: "case_type_schemas",
		path: "app_id|case_type|schema",
		disposition: "rewrite-current",
		semantic: "case-schema",
	},
	{
		id: "case-property-indexes.standard-properties",
		table: "cases",
		path: "schema_name|index_name|definition|is_valid",
		disposition: "DDL",
		semantic: "case-schema",
	},
	{
		id: "form_submission_intents.form",
		table: "form_submission_intents",
		path: "form_uuid",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
	{
		id: "form_submission_intents.operations",
		table: "form_submission_intents",
		path: "result.operations[].operationUuid",
		disposition: "rewrite-current",
		semantic: "current-blueprint",
	},
	{
		id: "form_attachments.field",
		table: "form_attachments",
		path: "field_uuid",
		disposition: "DDL",
		semantic: "sql-authored-identity",
	},
] as const satisfies readonly FrozenStorageOccurrence[];

/** One strict post-cutover mutation discriminator, including updateField once. */
export const FROZEN_FINAL_MUTATION_KINDS = [
	"addModule",
	"removeModule",
	"moveModule",
	"renameModule",
	"updateModule",
	"addForm",
	"removeForm",
	"moveForm",
	"renameForm",
	"updateForm",
	"addField",
	"removeField",
	"moveField",
	"updateField",
	"convertField",
	"setAppName",
	"setConnectType",
	"setAppLogo",
	"renameCaseProperties",
	"declareCaseType",
	"retireCaseType",
	"addCaseProperty",
	"setCaseProperty",
	"removeCaseProperty",
	"setCaseTypeMeta",
	"addUserProperty",
	"updateUserProperty",
	"removeUserProperty",
	"addUserType",
	"updateUserType",
	"removeUserType",
	"addPersona",
	"updatePersona",
	"removePersona",
	"addColumn",
	"updateColumn",
	"removeColumn",
	"moveColumn",
	"addSearchInput",
	"updateSearchInput",
	"removeSearchInput",
	"moveSearchInput",
	"setCaseListMeta",
	"addOption",
	"updateOption",
	"removeOption",
	"moveOption",
	"setFieldMedia",
	"setModuleMedia",
	"setFormMedia",
] as const;

export const FROZEN_OCCURRENCE_TABLES = [
	...new Set(FROZEN_STORAGE_OCCURRENCES.map((entry) => entry.table)),
] as const;

/**
 * Exact post-privilege projection of the logical occurrence inventory. The
 * lifecycle catalog owns the physical `cases` phase; callers that operate
 * before privilege convergence request that phase from it instead.
 */
export const FROZEN_OCCURRENCE_RELATIONS =
	FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS;

export function frozenEntityOccurrencesFor(
	entity: FrozenEntityKind,
	surface?: FrozenEntitySurface,
): readonly FrozenEntityOccurrence[] {
	return FROZEN_ENTITY_OCCURRENCES.filter(
		(entry) =>
			entry.entity === entity &&
			(surface === undefined || entry.surface === surface),
	);
}
