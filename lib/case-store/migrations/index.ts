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
};

export const caseStoreMigrationProvider: MigrationProvider = {
	getMigrations: async () => caseStoreMigrations,
};
