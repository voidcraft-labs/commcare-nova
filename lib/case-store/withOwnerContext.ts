// lib/case-store/withOwnerContext.ts
//
// The single production constructor path for `CaseStore` instances.
// API routes call `withOwnerContext(session.user.id)` once per
// request; the resulting `CaseStore` carries the owner id at every
// underlying SELECT / UPDATE / DELETE and cannot be reused across
// tenants.
//
// ## Why a factory, not a public constructor
//
// `PostgresCaseStore`'s constructor accepts both an `ownerId` and a
// `Kysely<Database>` handle. Tests pass an isolated per-test handle;
// production needs the singleton from `connection.ts`. The factory
// is the seam that picks the production handle without leaking the
// production-only `getCaseStoreDatabase` import to every API route.
//
// The factory is the migration anchor for future stricter-isolation
// models — switching to schema-per-tenant or database-per-tenant
// means changing the connection-routing logic in this one file,
// with no application-code rewrite.
//
// ## Tenant scoping is structural
//
// Construction-time enforcement, not caller discipline. Every
// `CaseStore` method internally adds `WHERE owner_id = <bound
// userId>` to the underlying query so a new method on the
// interface inherits the filter automatically. The factory is the
// single seam that pins `ownerId`; a `CaseStore` instance reused
// across tenants is structurally impossible because every instance
// carries one bound owner for life.
//
// ## Test path
//
// Tests do NOT call this factory. Tests construct `PostgresCaseStore`
// directly with an isolated `Kysely<Database>` instance (the
// `setupPerTestDatabase` helper at
// `lib/case-store/sql/__tests__/perTestDatabase.ts`). The factory is
// production-only because the singleton it threads is the live Cloud
// SQL connection — testcontainers runs against its own isolated
// engine and routes its own handle through the constructor.

import { getCaseStoreDatabase } from "./postgres/connection";
import { PostgresCaseStore } from "./postgres/store";
import type { CaseStore } from "./store";

/**
 * Construct a `CaseStore` bound to the supplied user's owner-id
 * scope. The returned instance is cheap to discard between
 * requests — it holds the singleton `Kysely<Database>` handle by
 * reference, not by ownership, so closing the request boundary
 * does not destroy the underlying pool.
 *
 * Async because `getCaseStoreDatabase()` resolves the connector +
 * pool lazily on first call (see
 * `lib/case-store/postgres/connection.ts`).
 *
 * @param userId - The Better Auth user id from the request's
 *   resolved session (`session.user.id`). The store binds this as
 *   its `owner_id` filter for every underlying query; cross-tenant
 *   reads are structurally impossible because the bound user
 *   cannot be reassigned after construction.
 *
 * @returns A `CaseStore` bound to the supplied user id.
 */
export async function withOwnerContext(userId: string): Promise<CaseStore> {
	const db = await getCaseStoreDatabase();
	return new PostgresCaseStore({ ownerId: userId, db });
}
