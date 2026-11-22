import "server-only";
import { decrypt } from "@/lib/commcare/encryption";
import {
	lookupSourceDefinitionDigest,
	probeHqInventoryRead,
	streamHqLookupTable,
} from "@/lib/commcare/hq/lookupSource";
import {
	type HqFixtureRow,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import { withAppTx } from "@/lib/db/pg";
import { resolveHqTarget } from "@/lib/db/settings";
import { LookupError } from "@/lib/lookup/errors";
import { reclaimLookupStorageBatch } from "@/lib/lookup/generations/recovery";
import type { InventoryRow } from "@/lib/lookup/generations/row";
import {
	type InventoryAccess,
	lockInventoryScope,
} from "@/lib/lookup/generations/scope";
import {
	beginInventory,
	cancelInventory,
	checkInventoryRun,
	pauseInventory,
	promoteInventory,
	stageInventoryPage,
} from "@/lib/lookup/generations/store";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	canonicalLookupObservation,
	lookupDefinitionDigest,
	streamingLookupRowsDigest,
} from "./hqResourceBaseline";
import { lookupFieldShapeObserver } from "./reading/projectData/lookupTables";
import { withSourceBulkRead } from "./sourceReadBudget";

function inventoryRow(row: HqFixtureRow): InventoryRow {
	return {
		sourceId: row.id,
		...(row.sortKey === undefined ? {} : { sortKey: row.sortKey }),
		attributes: row.itemAttributes ?? {},
		fields: Object.fromEntries(
			Object.entries(row.fields).map(([name, value]) => [
				name,
				typeof value === "string" ? [{ value, properties: {} }] : value,
			]),
		),
	};
}

export async function refreshSourceInventory(
	access: InventoryAccess,
	source: { server: string; domain: string; remoteId: string; tag: string },
) {
	return withSourceBulkRead(async (signal) => {
		// Check the confirmed source and the grant before making an HQ request.
		await withAppTx(async (tx) => {
			await lockInventoryScope(tx, access);
			await reclaimLookupStorageBatch(tx, access.scope.projectId);
		});
		const target = await resolveHqTarget(access.scope.actorId, source.domain);
		if (!target.ok || target.server !== source.server)
			return {
				ok: false as const,
				reason: "cannot-read" as const,
				message:
					"You can reconnect to the project space that manages this table.",
			};
		const creds = {
			server: target.server,
			username: target.username,
			apiKey: await decrypt(target.encryptedApiKey),
		};
		const tables = await listHqLookupTables(creds, source.domain, {
			cancel: signal,
		});
		if ("success" in tables)
			return {
				ok: false as const,
				reason: "cannot-read" as const,
				message:
					"Nova couldn't read the table definitions in this project space. You can check the connection and retry.",
			};
		const table = tables.find(
			(t) => t.id === source.remoteId && t.tag === source.tag,
		);
		if (!table)
			return {
				ok: false as const,
				reason: "table-gone" as const,
				message:
					"The source table changed. You can bring in its current definition again.",
			};
		const { run, checkpoint } = await beginInventory(access, {
			...source,
			keyDigest: canonicalJsonDigest(target.encryptedApiKey),
			canonicalDefinition: lookupDefinitionDigest(table),
			reconcileDefinition: true,
			definitionDigest: lookupSourceDefinitionDigest(
				creds,
				source.domain,
				table,
			),
		});
		try {
			const digest = streamingLookupRowsDigest();
			const shape = lookupFieldShapeObserver(table);
			const result = await streamHqLookupTable(creds, source.domain, table, {
				checkpoint,
				cancel: signal,
				maxBytes: 64 * 1024 ** 3,
				maxRequests: 250_000,
				deadlineMs: Math.max(
					1000,
					(RUNTIME_CAPABILITIES.cloudRunRequestSeconds - 30) * 1000,
				),
				authorizePage: () => checkInventoryRun(run),
				verifyRow: (row) => {
					digest.row(row);
					shape.observe(row);
				},
				async stage(page) {
					await stageInventoryPage(run, {
						...page,
						rows: page.rows.map(inventoryRow),
					});
					return true;
				},
			});
			if ("success" in result) {
				if (result.cause === "moved" || result.cause === "malformed") {
					await cancelInventory(access, run.id);
					return {
						ok: false as const,
						reason: "state-changed" as const,
						message:
							"The source changed during verification. Your previous inventory is still available. You can refresh again.",
					};
				}
				await pauseInventory(run);
				return {
					ok: false as const,
					reason: "unavailable" as const,
					message:
						"The source read stopped before verification finished. You can reconnect or resume the refresh from Project data.",
				};
			}
			const measured = digest.finish();
			if (measured.count !== result.totalCount)
				throw new LookupError(
					"conflict",
					"The verified row count changed. You can refresh the source again.",
				);
			const canonical = canonicalLookupObservation(
				table,
				result.totalCount,
				measured.digest,
			);
			const receipt = await promoteInventory(
				run,
				result,
				{
					...canonical,
					source: { ...canonical.source, storage: "generation" },
				},
				{
					fields: table.fields,
					attributes: table.itemAttributes,
					fieldDetails: shape.finish(),
					rows: [],
				},
			);
			return { ok: true as const, receipt };
		} catch (error) {
			// Release the run's slot without disclosing or deleting its staged bytes.
			await pauseInventory(run);
			throw error;
		}
	});
}

/** Reprove the server-side row permission before any historical receipt or
 * row leaves Nova. The database page supplies no bytes until the following
 * local recheck also sees the identical grant, membership and source key. */
export async function inspectSourceInventory<T>(
	access: InventoryAccess,
	read: (verifiedScope: string) => Promise<T>,
) {
	const { table, origin, keyDigest, scopeDigest } = await withAppTx((tx) =>
		lockInventoryScope(tx, access),
	);
	const target = await resolveHqTarget(access.scope.actorId, origin.domain);
	if (
		!target.ok ||
		target.server !== table.hq_server ||
		canonicalJsonDigest(target.encryptedApiKey) !== keyDigest
	)
		throw new LookupError(
			"not_found",
			"You can reconnect to the project space that manages this inventory.",
		);
	const creds = {
		server: target.server,
		username: target.username,
		apiKey: await decrypt(target.encryptedApiKey),
	};
	if (
		!(await probeHqInventoryRead(
			creds,
			origin.domain,
			origin.remoteId,
			table.tag,
		))
	)
		throw new LookupError(
			"not_found",
			"Nova could not verify access to the source inventory. You can check your project-space connection.",
		);
	return read(scopeDigest);
}
