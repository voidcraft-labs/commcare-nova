import "server-only";
import { sql } from "kysely";
import {
	resolveAppScopeInTransaction,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { type AppTestScope, appTestLookupProof } from "@/lib/db/appTests";
import { withAppTx } from "@/lib/db/pg";
import type { WorkerProjectionAccess } from "@/lib/deployment/workerLookupProjection";
import { readWorkerLookupProjection, workerProjectionGrant, type WorkerProjectionGrantCheck } from "@/lib/deployment/workerLookupProjection";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	getLookupDefinitions,
	getLookupFixtureData,
} from "@/lib/lookup/service";
import { requiresLookupProjection } from "@/lib/lookup/source";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {appReadsWorkerGroups} from "../engine/expressionCaseReads";
import { appTestPersona } from "./addresses";
import { AppTestActionError } from "./errors";
import type {
	AppTestLookupProof,
	AppTestSnapshot,
	AppTestStartInput,
} from "./types";

export type AppTestLookupScope = AppTestScope & {
	workerGrant?: WorkerProjectionAccess["grant"];
};
export function appTestLookupKey(
	snapshot: LookupFixtureDataSnapshot,
	personaUuid: Uuid | null,
	workerBinding?: string,
	groupScope?: import("../engine/restoreScope").WorkerRestoreScope,
) {
	// A native fixture has ordered row values, never remote row identities.
	const rows = snapshot.definitions.map((table) => [
		table.id,
		snapshot.rowsByTable
			.get(table.id)
			?.map((row) => [
				requiresLookupProjection(table.hq) ? null : row.id,
				row.values,
				row.attributes ?? {},
				row.occurrences ?? {},
			]),
	]);
	return canonicalJsonDigest([
		personaUuid,
		workerBinding ?? null,
		snapshot.definitions,
		rows,
		...(groupScope ? [groupScope.groups, groupScope.ownerIds] : []),
	]);
}
function unavailable(): never {
	throw new AppTestActionError(
		"This journey uses worker-specific data. You can reconnect the original worker or start a test with their current data.",
	);
}
async function readWorker(
	scope: AppTestLookupScope,
	ids: readonly LookupTableId[],
	personaUuid: Uuid | null,
	includeGroups = false,
) {
	if (!scope.workerGrant) return unavailable();
	return readWorkerLookupProjection(
		{ scope, grant: scope.workerGrant, personaUuid: personaUuid ?? undefined },
		ids,
		includeGroups,
	);
}
type WorkerCapture = {
	check:WorkerProjectionGrantCheck;
	revision: string;
	digest: string;
	worker: NonNullable<AppTestSnapshot["lookup"]["workers"]>[number];
};
const LOOKUP_LIMIT = 32 * 1024 * 1024;
function assertCapacity(bytes: number) {
	if (bytes > LOOKUP_LIMIT)
		throw new AppTestActionError(
			"The combined worker data exceeds this test’s capacity. You can start a journey with fewer workers or smaller assignments.",
		);
}
async function captureWorker(
	scope: AppTestLookupScope,
	proof: AppTestLookupProof,
	personaUuid: Uuid | null,
): Promise<WorkerCapture> {
	const current = await readWorker(
		scope,
		proof.tableIds,
		personaUuid,
		proof.groups,
	);
	return {
		check:workerProjectionGrant(current),
		revision: current.projectRevision,
		digest: appTestLookupKey(
			current,
			personaUuid,
			current.workerBinding,
			current.groupScope,
		),
		worker: {
			personaUuid,
			rows: [...current.rowsByTable],
			...(current.groupScope && { groupScope: current.groupScope }),
		},
	};
}
export async function captureAppTestLookup(
	scope: AppTestLookupScope & { role: string },
	doc: BlueprintDoc,
	tableIds: readonly LookupTableId[],
	input: AppTestStartInput,
	checks: WorkerProjectionGrantCheck[],
): Promise<AppTestSnapshot["lookup"]> {
	const project = {
		projectId: scope.projectId,
		actorId: scope.actorUserId,
		role: scope.role,
	};
	const catalog = await getLookupDefinitions(project, tableIds);
	const privateIds = catalog.definitions
		.filter(
			(table) =>
				table.workerAccess === "assigned" || requiresLookupProjection(table.hq),
		)
		.map((table) => table.id);
	const restricted = new Set(privateIds);
	const shared = await getLookupFixtureData(
		project,
		tableIds.filter((id) => !restricted.has(id)),
	);
	if (shared.projectRevision !== catalog.projectRevision) return unavailable();
	const lookup: AppTestSnapshot["lookup"] = {
		projectRevision: shared.projectRevision,
		definitions: catalog.definitions,
		rows: [...shared.rowsByTable],
	};
	// Group membership changes the worker's case list even with automatic group ownership off.
	const groups =
		appReadsWorkerGroups(doc) ||
		(await withAppTx(async (tx) => {
			const app = await resolveAppScopeInTransaction(
				tx,
				scope.appId,
				scope.actorUserId,
				"view",
			);
			if (app.projectId !== scope.projectId) return unavailable();
			return !!(
				await sql`SELECT 1 FROM worker_group_members m JOIN worker_groups g ON (g.project_id,g.id)=(m.project_id,m.group_id) WHERE m.project_id=${scope.projectId} AND m.app_id=${scope.appId} AND g.shares_cases LIMIT 1`.execute(
					tx,
				)
			).rows.length;
		}));
	if (!privateIds.length && !groups) return lookup;
	const workers = [];
	const proof: AppTestLookupProof = {
		tableIds: privateIds,
		workers: [],
		...(groups && { groups: true }),
	};
	let bytes = Buffer.byteLength(JSON.stringify(lookup), "utf8");
	const personas = new Set(
		(input.sessions ?? [{ personaUuid: null }]).map((session) =>
			appTestPersona(doc, session.personaUuid ?? null),
		),
	);
	for (const personaUuid of personas) {
		const { worker, digest, revision, check } = await captureWorker(
			scope,
			proof,
			personaUuid,
		);
		if (revision !== catalog.projectRevision) return unavailable();
		bytes += Buffer.byteLength(JSON.stringify(worker), "utf8");
		assertCapacity(bytes);
		proof.workers.push({ personaUuid, digest });
		workers.push(worker);
		checks.push(check);
	}
	return { ...lookup, workers, proof };
}

async function verifyAppTestLookup(
	scope: AppTestLookupScope,
	proof: AppTestLookupProof,
) {
	const checks:WorkerProjectionGrantCheck[]=[];
	for (const worker of proof.workers) {
		const current = await readWorker(
			scope,
			proof.tableIds,
			worker.personaUuid,
			proof.groups,
		);
		if (
			appTestLookupKey(
				current,
				worker.personaUuid,
				current.workerBinding,
				current.groupScope,
			) !== worker.digest
		)
			return unavailable();
		checks.push(workerProjectionGrant(current));
	}
	return {workerProofKey:canonicalJsonDigest(proof), workerGrantChecks:checks};
}
export function lookupRowsForTestWorker(
	lookup: AppTestSnapshot["lookup"],
	personaUuid: Uuid | null,
) {
	if (!lookup.proof) return new Map(lookup.rows);
	const selected = lookup.workers?.find(
		(worker) => worker.personaUuid === personaUuid,
	);
	if (!selected)
		throw new AppTestActionError(
			"This worker’s data was not captured for this journey. You can start a test with this worker in its sessions.",
		);
	return new Map([...lookup.rows, ...selected.rows]);
}

/** Fetch new identities outside the isolated transaction. Only a successfully
 * applied identity action adds its capture to the journey and its future grant. */
export async function prepareAppTestIdentities(
	scope: AppTestLookupScope,
	testId: string,
	references: readonly (string | null)[],
) {
	const additions = new Map<Uuid | null, WorkerCapture>();
	if (!references.length) return additions;
	const proof = await appTestLookupProof(scope, { testId });
	if (!proof) return additions;
	const authorized = await resolveAuthorizedAppSnapshot(
		scope.appId,
		scope.actorUserId,
		"view",
	);
	if (authorized.projectId !== scope.projectId) return unavailable();
	const doc = hydratePersistedBlueprint(authorized.app.blueprint);
	let bytes = 0;
	for (const reference of new Set(references)) {
		let personaUuid: Uuid | null;
		try {
			personaUuid = appTestPersona(doc, reference);
		} catch (error) {
			// The action binder retains its ordinary named refusal at its own step.
			if (error instanceof AppTestActionError) continue;
			throw error;
		}
		if (
			proof.workers.some((worker) => worker.personaUuid === personaUuid) ||
			additions.has(personaUuid)
		)
			continue;
		const captured = await captureWorker(scope, proof, personaUuid);
		bytes += Buffer.byteLength(JSON.stringify(captured.worker), "utf8");
		assertCapacity(bytes);
		additions.set(personaUuid, captured);
	}
	return additions;
}
export function includeAppTestIdentity(
	snapshot: AppTestSnapshot,
	personaUuid: Uuid | null,
	additions: ReadonlyMap<Uuid | null, WorkerCapture>,
): AppTestSnapshot {
	const { lookup } = snapshot;
	if (
		!lookup.proof ||
		lookup.proof.workers.some((worker) => worker.personaUuid === personaUuid)
	)
		return snapshot;
	const captured = additions.get(personaUuid);
	if (!captured || captured.revision !== lookup.projectRevision)
		return unavailable();
	const next = {
		...lookup,
		workers: [...(lookup.workers ?? []), captured.worker],
		proof: {
			...lookup.proof,
			workers: [
				...lookup.proof.workers,
				{ personaUuid, digest: captured.digest },
			],
		},
	};
	assertCapacity(Buffer.byteLength(JSON.stringify(next), "utf8"));
	return { ...snapshot, lookup: next };
}

export async function withCurrentAppTestProof(
	scope: AppTestLookupScope,
	selector: { testId: string } | { requestId: string },
): Promise<AppTestScope> {
	const proof = await appTestLookupProof(scope, selector);
	return proof
		? { ...scope, ...await verifyAppTestLookup(scope, proof) }
		: scope;
}
