// Case-store migration set + provider.
//
// Static (import-based) `MigrationProvider` rather than Kysely's
// `FileMigrationProvider`: the migrations run in three environments — the
// production migrate entrypoint (bundled by esbuild into a single CJS file,
// where `fs`-walking a `migrationFolder` path would not resolve), the
// testcontainers harness, and `npm run dev` — and a static import map works
// identically in all three with no filesystem assumptions. Adding a migration
// is one import + one record entry here.
//
// Keys are the migration names Kysely records in its `kysely_migration`
// ledger; they sort lexicographically, so the timestamp prefix preserves
// apply order. The first two entries are idempotent *adoption baselines* (see
// `lib/case-store/migrate.ts` + each module's header); later entries are normal
// forward-only migrations.

import type { Migration, MigrationProvider } from "kysely/migration";
import * as baseline from "./20260505152732_baseline";
import * as addCaseNameColumn from "./20260506022302_add_case_name_column";
import * as addCasesProjectId from "./20260627000000_add_cases_project_id";
import * as addCaseTypeSchemasSyncedSeq from "./20260630000000_add_case_type_schemas_synced_seq";
import * as appState from "./20260708000000_app_state";
import * as addCasesExternalId from "./20260709000000_add_cases_external_id";
import * as addActualCost from "./20260710000000_add_actual_cost";
import * as chatStreamChunks from "./20260713000000_chat_stream_chunks";
import * as threadsFirstClass from "./20260714000000_threads_first_class";
import * as openaiModelIds from "./20260719000000_openai_model_ids";
import * as dropActualCost from "./20260720000000_drop_actual_cost";
import * as parkedCaseValues from "./20260721000000_parked_case_values";
import * as setAsideReview from "./20260722000000_set_aside_review";
import * as lookupTables from "./20260722053000_lookup_tables";
import * as lookupReferenceInfrastructure from "./20260722060000_lookup_reference_infrastructure";
import * as runtimeReaderRollout from "./20260722080000_runtime_reader_rollout";
import * as runHolderNonce from "./20260722120000_run_holder_nonce";
import * as mediaReferenceIndexState from "./20260722140000_media_reference_index_state";
import * as mediaUploadAliases from "./20260722203000_media_upload_aliases";
import * as lookupReferenceFloors from "./20260723120000_lookup_reference_floors";
import * as opaqueCaseIds from "./20260724030000_opaque_case_ids";
import * as caseOperationsFlag from "./20260724130000_case_operations_flag";
import * as removeLookupRolloutApparatus from "./20260725000000_remove_lookup_rollout_apparatus";
import * as clearLegacyNullNonceHolders from "./20260725060000_clear_legacy_null_nonce_holders";
import * as blueprintUserEntities from "./20260725120000_blueprint_user_entities";
import * as formAttachments from "./20260726000000_form_attachments";
import * as sequenceIsArrayPosition from "./20260727120000_sequence_is_array_position";
import * as canonicalIdentityFoundation from "./20260728000000_canonical_identity_foundation";
import * as caseSchemaIndexConvergence from "./20260728010000_case_schema_index_convergence";
import * as caseTypeSchemaRetirement from "./20260802000000_case_type_schema_retirement";
import * as organizationModel from "./20260802010000_organization_model";
import * as automations from "./20260803010000_automations";
import * as chatRecoveryBreadcrumbs from "./20260805010000_chat_recovery_breadcrumbs";
import * as deployments from "./20260806000000_deployments";
import * as designChangeSets from "./20260807000000_design_change_sets";
import * as designArtifacts from "./20260808000000_design_artifacts";
import * as designSessions from "./20260809000000_design_sessions";
import * as designOrchestration from "./20260810000000_design_orchestration";
import * as designArtifactWorkspaces from "./20260810010000_design_artifact_workspaces";
import * as executorAttemptRecovery from "./20260811000000_executor_attempt_recovery";
import * as designModelContexts from "./20260811010000_design_model_contexts";
import * as designIdentityHandles from "./20260811020000_design_identity_handles";
import * as sliceAttemptBudgetClaims from "./20260811030000_slice_attempt_budget_claims";
import * as modelStepUsageAccounts from "./20260811040000_model_step_usage_accounts";

export const CANONICAL_IDENTITY_FOUNDATION_MIGRATION_NAME =
	"20260728000000_canonical_identity_foundation";

/** Migration name → module, in apply order (lexicographic by key). */
export const caseStoreMigrations: Record<string, Migration> = {
	"20260505152732_baseline": baseline,
	"20260506022302_add_case_name_column": addCaseNameColumn,
	"20260627000000_add_cases_project_id": addCasesProjectId,
	"20260630000000_add_case_type_schemas_synced_seq":
		addCaseTypeSchemasSyncedSeq,
	"20260708000000_app_state": appState,
	"20260709000000_add_cases_external_id": addCasesExternalId,
	"20260710000000_add_actual_cost": addActualCost,
	"20260713000000_chat_stream_chunks": chatStreamChunks,
	"20260714000000_threads_first_class": threadsFirstClass,
	"20260719000000_openai_model_ids": openaiModelIds,
	"20260720000000_drop_actual_cost": dropActualCost,
	"20260721000000_parked_case_values": parkedCaseValues,
	"20260722000000_set_aside_review": setAsideReview,
	"20260722053000_lookup_tables": lookupTables,
	"20260722060000_lookup_reference_infrastructure":
		lookupReferenceInfrastructure,
	"20260722080000_runtime_reader_rollout": runtimeReaderRollout,
	"20260722120000_run_holder_nonce": runHolderNonce,
	"20260722140000_media_reference_index_state": mediaReferenceIndexState,
	"20260722203000_media_upload_aliases": mediaUploadAliases,
	"20260723120000_lookup_reference_floors": lookupReferenceFloors,
	"20260724030000_opaque_case_ids": opaqueCaseIds,
	"20260724130000_case_operations_flag": caseOperationsFlag,
	"20260725000000_remove_lookup_rollout_apparatus":
		removeLookupRolloutApparatus,
	"20260725060000_clear_legacy_null_nonce_holders": clearLegacyNullNonceHolders,
	"20260725120000_blueprint_user_entities": blueprintUserEntities,
	"20260726000000_form_attachments": formAttachments,
	"20260727120000_sequence_is_array_position": sequenceIsArrayPosition,
	[CANONICAL_IDENTITY_FOUNDATION_MIGRATION_NAME]: canonicalIdentityFoundation,
	"20260728010000_case_schema_index_convergence": caseSchemaIndexConvergence,
	"20260802000000_case_type_schema_retirement": caseTypeSchemaRetirement,
	"20260802010000_organization_model": organizationModel,
	"20260803010000_automations": automations,
	"20260805010000_chat_recovery_breadcrumbs": chatRecoveryBreadcrumbs,
	"20260806000000_deployments": deployments,
	"20260807000000_design_change_sets": designChangeSets,
	"20260808000000_design_artifacts": designArtifacts,
	"20260809000000_design_sessions": designSessions,
	"20260810000000_design_orchestration": designOrchestration,
	"20260810010000_design_artifact_workspaces": designArtifactWorkspaces,
	"20260811000000_executor_attempt_recovery": executorAttemptRecovery,
	"20260811010000_design_model_contexts": designModelContexts,
	"20260811020000_design_identity_handles": designIdentityHandles,
	"20260811030000_slice_attempt_budget_claims": sliceAttemptBudgetClaims,
	"20260811040000_model_step_usage_accounts": modelStepUsageAccounts,
};

export const caseStoreMigrationProvider: MigrationProvider = {
	getMigrations: async () => caseStoreMigrations,
};
