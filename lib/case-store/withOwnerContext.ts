// lib/case-store/withOwnerContext.ts
//
// The single production constructor path for `CaseStore` instances.
// API routes call `withOwnerContext(session.user.id)` once per
// request; the resulting `CaseStore` carries the owner id at every
// underlying SELECT / UPDATE / DELETE. The factory routes the
// `getCaseStoreDatabase()` singleton into `PostgresCaseStore`'s
// constructor so a change to the connection routing strategy lands
// here rather than at every API route.
//
// Tests do NOT call this factory — they construct
// `PostgresCaseStore` directly with an isolated per-test
// `Kysely<Database>` instance from
// `lib/case-store/sql/__tests__/perTestDatabase.ts`.
//
// Tenant scoping is structural: the bound owner id flows through
// every method's underlying query as `WHERE owner_id = <bound>`,
// and `compileRelationPath` adds the JOIN-side filter on every
// joined `cases` row. The two halves combine to make cross-tenant
// reads structurally impossible.

import { getCaseStoreDatabase } from "./postgres/connection";
import { PostgresCaseStore } from "./postgres/store";
import { HeuristicCaseGenerator } from "./sample/heuristic";
import type { CaseStore } from "./store";

/**
 * Construct a `CaseStore` bound to the supplied user's owner-id
 * scope. The returned instance holds the singleton
 * `Kysely<Database>` by reference, so discarding it at the request
 * boundary does not destroy the underlying pool. Async because
 * `getCaseStoreDatabase()` resolves the connector + pool lazily on
 * first call.
 */
export async function withOwnerContext(userId: string): Promise<CaseStore> {
	const db = await getCaseStoreDatabase();
	return new PostgresCaseStore({
		ownerId: userId,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}
