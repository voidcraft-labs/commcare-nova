// lib/case-store/projectContext.ts
//
// The production constructor paths for `CaseStore` / `SchemaCaseStore`
// instances. Two factories split by what the caller needs:
//
//   - `withProjectContext(projectId, actorUserId)` — the tenant-bound
//     read/write store the 7 case-data Server Actions use. Every
//     underlying SELECT / UPDATE / DELETE carries
//     `WHERE project_id = <bound>`, and every insert stamps the new
//     case's `owner_id = <actor>` (the CommCare case-owner — the
//     reserved axis future location-based access carves on, distinct
//     from the Project tenant filter); `compileRelationPath` adds the
//     JOIN-side `project_id` filter on every joined `cases` row.
//     The two halves make cross-Project reads structurally impossible.
//     The caller resolves Project + membership before binding for reads. Every
//     actor write additionally re-proves fresh edit access and exact Project
//     placement inside its own case transaction; the up-front result is never
//     write authority.
//   - `withSchemaContext()` — the actor-free store for schema-only
//     callers (the cross-store saga, the chat-completion materialize,
//     the point-of-use heal). It can run `applySchemaChange` /
//     `dropSchema` (app-scoped — they cover every member's rows of the
//     app's case type). Each schema write locks the app `FOR SHARE` and
//     observes its current Project in the write transaction, but the store
//     exposes no tenant-bound case-data method.
//
// Both route the `getCaseStoreDatabase()` singleton into
// `PostgresCaseStore` so a change to the connection-routing strategy
// lands here rather than at every call site. Async because
// `getCaseStoreDatabase()` resolves the connector + pool lazily on
// first call.
//
// Tests do NOT call these factories — they construct `PostgresCaseStore`
// directly with an isolated per-test `Kysely<Database>` instance from
// `lib/case-store/sql/__tests__/perTestDatabase.ts`.

import {
	authorizeCaseMutationInTransaction,
	authorizeSystemSchemaMutationInTransaction,
} from "@/lib/db/caseMutationAuthorization";
import { getCaseStoreDatabase } from "./postgres/connection";
import { PostgresCaseStore } from "./postgres/store";
import { HeuristicCaseGenerator } from "./sample/heuristic";
import type { CaseStore, TransactionalSchemaCaseStore } from "./store";

/**
 * Construct a tenant-bound `CaseStore` scoped to `projectId`, stamping
 * `actorUserId` as the `owner_id` (CommCare case-owner) of every row it
 * inserts. The returned instance holds the singleton `Kysely<Database>`
 * by reference, so discarding it at the request boundary does not
 * destroy the underlying pool.
 */
export async function withProjectContext(
	projectId: string,
	actorUserId: string,
): Promise<CaseStore> {
	const db = await getCaseStoreDatabase();
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeMutation: authorizeCaseMutationInTransaction,
		authorizeSchemaMutation: async (tx, args) => {
			await authorizeSystemSchemaMutationInTransaction(tx, args);
		},
	});
}

/**
 * Construct an actor-free `SchemaCaseStore` for app-scoped schema
 * operations (`applySchemaChange` / `dropSchema`). The instance binds no
 * Project, but each write dynamically locks the live app and observes its
 * current Project before touching schema/case rows. The narrow return type
 * prevents a schema-only caller from reaching tenant-bound case data.
 */
export async function withSchemaContext(): Promise<TransactionalSchemaCaseStore> {
	const db = await getCaseStoreDatabase();
	return new PostgresCaseStore({
		projectId: null,
		actorUserId: null,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeSchemaMutation: async (tx, args) => {
			await authorizeSystemSchemaMutationInTransaction(tx, args);
		},
	});
}
