import "server-only";
import { z } from "zod";
import { readSelectedWorkbookGrids } from "@/lib/agent/officeProcess";
import { HQ_LOOKUP_TABLE_ROWS_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { readVerifiedGlobalLookupRows } from "@/lib/commcare/hq/lookupCoverage";
import { lookupWorkbookPrincipals } from "@/lib/commcare/hq/lookupOwners";
import {
	inspectSelectedHqRowAt,
	lookupSourceDefinitionDigest,
	readSelectedHqLookupRows,
	verifyHqLookupDefinition,
} from "@/lib/commcare/hq/lookupSource";
import {
	type HqFixtureRow,
	type HqLookupTable,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import {
	bindWorkbookOwners,
	LookupWorkbookMismatch,
	lookupWorkbookCandidates,
	observeLookupWorkbook,
	selectedLookupSheets,
} from "@/lib/commcare/hq/lookupWorkbook";
import {
	giveBackHeld,
	processMemoryMeter,
	runInLease,
} from "@/lib/commcare/hq/memoryMeter";
import { withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { LookupError } from "@/lib/lookup/errors";
import {
	type InventoryAccess,
	lockInventoryScope,
	sourceChanged,
} from "@/lib/lookup/generations/scope";
import { lookupSourceFactsSchema } from "@/lib/lookup/source";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { canonicalLookupTable } from "./hqResourceBaseline";
import { inspectSourceInventory } from "./managedInventory";

/** Fits one authenticated browser action, including multipart metadata. */
export const sourceWorkbookBytes = 768 * 1024;
const rejected = () =>
	new LookupError(
		"invalid_input",
		"Nova couldn't verify this workbook. You can download just this table from its project space and check your connection to its worker, group and place directories.",
	);
const receiptSchema = z.strictObject({
	source: z.literal("selected-workbook"),
	tag: z.string(),
	domain: z.string(),
	server: z.string(),
	remoteId: z.string(),
	observedAt: z.iso.datetime(),
	rows: z.number().int().min(0),
	assignedRows: z.number().int().min(0),
	indexedFields: z.array(z.string()),
	workbookDigest: z.string(),
	definitionDigest: z.string(),
	contentDigest: z.string(),
});
export type SourceWorkbookReceipt = z.infer<typeof receiptSchema>;

/** Historical evidence stays private to Project editors with a current source
 * grant. Neither a device nor a future carrier can consume it as fresh authority. */
export async function historicalSourceWorkbook(access: InventoryAccess) {
	return inspectSourceInventory(access, async (expectedScope) =>
		withAppTx(async (tx) => {
			const { table, scopeDigest } = await lockInventoryScope(tx, access);
			if (scopeDigest !== expectedScope) return sourceChanged();
			const observation = table.hq_source_observation;
			const receipt = receiptSchema.safeParse(observation?.receipt);
			return receipt.success &&
				receipt.data.remoteId === table.hq_remote_id &&
				receipt.data.tag === table.tag &&
				receipt.data.server === table.hq_server &&
				receipt.data.domain === table.hq_domain
				? receipt.data
				: null;
		}),
	);
}

export interface SelectedWorkbookEvidence {
	receipt: SourceWorkbookReceipt;
	owners: ReturnType<typeof bindWorkbookOwners>;
	rows: readonly HqFixtureRow[];
	table: HqLookupTable;
	credentials: CommCareCredentials;
	scopeDigest: string;
	revision: string;
	signal: AbortSignal;
}

/** A fresh upload stays within the selected source memory lease. An action using
 * this evidence must obtain its own current grant before any disclosure or write. */
export async function withFreshSelectedWorkbook<T>(
	access: InventoryAccess,
	bytes: Buffer,
	purpose: "read" | "transfer",
	use: (evidence: SelectedWorkbookEvidence) => Promise<T>,
): Promise<T> {
	if (bytes.length > sourceWorkbookBytes || !bytes.length) throw rejected();
	const lease = processMemoryMeter().open();
	try {
		return await runInLease(lease, async () => {
			const initial = await withAppTx((tx) =>
				lockInventoryScope(tx, access, purpose),
			);
			const { table: local } = initial;
			const domain = local.hq_domain;
			if (!domain || !local.hq_remote_id || !local.hq_server) throw rejected();
			const grant = await getHqCredentials(access.scope.actorId, domain);
			if (
				!grant.ok ||
				grant.creds.server !== local.hq_server ||
				grant.creds.username !== initial.username
			)
				throw rejected();
			let workbook: z.infer<typeof selectedLookupSheets>;
			try {
				workbook = selectedLookupSheets.parse(
					await readSelectedWorkbookGrids(bytes, local.tag, lease.signal),
				);
			} catch {
				throw rejected();
			}
			const ids = lookupWorkbookCandidates(workbook);
			const list = await listHqLookupTables(grant.creds, domain, {
				cancel: lease.signal,
			});
			if ("success" in list) throw rejected();
			const peers = list.filter((candidate) => candidate.tag === local.tag);
			const [table] = peers;
			if (peers.length !== 1 || !table || table.id !== local.hq_remote_id)
				throw rejected();
			const cap = HQ_LOOKUP_TABLE_ROWS_MAX_BYTES;
			let observed = await readSelectedHqLookupRows(
				grant.creds,
				domain,
				table,
				{ maxBytes: cap, maxRows: ids.length, cancel: lease.signal },
			);
			if (
				"success" in observed &&
				observed.status === 500 &&
				!observed.edgeRefusal &&
				observed.cause === undefined &&
				table.isGlobal
			) {
				observed = await readVerifiedGlobalLookupRows(
					grant.creds,
					domain,
					table,
					{
						binding: initial.scopeDigest,
						candidates: ids,
						maxBytes: cap,
						cancel: lease.signal,
					},
				);
			}
			if ("success" in observed || "kind" in observed) throw rejected();
			try {
				const workbookFacts = observeLookupWorkbook(
					table,
					observed.rows,
					workbook,
				);
				const principals = await lookupWorkbookPrincipals(
					grant.creds,
					domain,
					workbookFacts.owners,
					lease.signal,
				);
				const owners = bindWorkbookOwners(workbookFacts, principals);
				if (
					await verifyHqLookupDefinition(
						grant.creds,
						domain,
						table,
						lease.signal,
					)
				)
					throw rejected();
				const receipt: SourceWorkbookReceipt = {
					source: "selected-workbook",
					tag: table.tag,
					domain,
					server: grant.creds.server,
					remoteId: table.id,
					observedAt: new Date().toISOString(),
					rows: observed.rows.length,
					assignedRows: owners.filter((row) =>
						Object.values(row.owners).some((list) => list.length > 0),
					).length,
					indexedFields: workbookFacts.indexedFields,
					workbookDigest: workbookFacts.workbookDigest,
					definitionDigest: lookupSourceDefinitionDigest(
						grant.creds,
						domain,
						table,
					),
					contentDigest: canonicalLookupTable(table, observed.rows).digest,
				};
				const current = await withAppTx((tx) =>
					lockInventoryScope(tx, access, purpose),
				);
				if (
					current.scopeDigest !== initial.scopeDigest ||
					current.revision !== initial.revision
				)
					return sourceChanged();
				return await use({
					receipt,
					owners,
					rows: observed.rows,
					table,
					credentials: grant.creds,
					scopeDigest: initial.scopeDigest,
					revision: initial.revision,
					signal: lease.signal,
				});
			} finally {
				giveBackHeld("text", observed.bytes);
			}
		});
	} catch (error) {
		if (error instanceof LookupWorkbookMismatch) throw rejected();
		throw error;
	} finally {
		lease.end();
	}
}

export async function attestSourceWorkbook(
	access: InventoryAccess,
	bytes: Buffer,
): Promise<SourceWorkbookReceipt> {
	return withFreshSelectedWorkbook(
		access,
		bytes,
		"read",
		async ({ receipt, owners, scopeDigest, revision }) => {
			const payload = JSON.stringify({
				receipt,
				attestedBy: access.scope.actorId,
				owners,
				orderedRowDigest: canonicalJsonDigest(owners.map((row) => row.rowId)),
			});
			if (Buffer.byteLength(payload) > 3 * 1024 * 1024) throw rejected();
			await withAppTx(async (tx) => {
				const current = await lockInventoryScope(tx, access);
				if (
					current.scopeDigest !== scopeDigest ||
					current.revision !== revision
				)
					return sourceChanged();
				await tx
					.updateTable("lookup_tables")
					.set({ hq_source_observation: payload })
					.where("project_id", "=", access.scope.projectId)
					.where("id", "=", access.tableId)
					.executeTakeFirstOrThrow();
			});
			return receipt;
		},
	);
}

/** An inspection returns a bounded sample with its complete count. The calling
 * worker engine uses the full fresh projection internally. Neither accepts
 * these inspection rows back as current worker data. */
export function workerInspection(
	projection: import("@/lib/commcare/hq/lookupRestore").LookupWorkerProjection,
) {
	const sample: (typeof projection.rows)[number][] = [];
	let bytes = 0;
	for (const row of projection.rows) {
		const length = Buffer.byteLength(JSON.stringify(row));
		if (sample.length === 8 || bytes + length > 12_000) break;
		sample.push(row);
		bytes += length;
	}
	return {
		worker: projection.workerName,
		principal: projection.principal,
		observedAt: projection.observedAt,
		rows: projection.rows.length,
		indexedFields: projection.indexedFields,
		sample,
	};
}

/** Inspect one live selected detail of an inline private inventory. The ordinal
 * is meaningful only in the reviewed revision. This does not answer what a
 * worker receives and cannot be reused as a device fixture. */
export async function inspectInlineSourceRow(
	access: InventoryAccess,
	ordinal: number,
	expectedRevision?: string,
) {
	if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw rejected();
	const refusal = () =>
		new LookupError(
			"managed_in_hq",
			"The inline source inventory is unavailable. You can refresh the inventory and open the completed copy.",
		);
	const read = await withAppTx(async (tx) => {
		const s = await lockInventoryScope(tx, access);
		const source = lookupSourceFactsSchema.safeParse(
			s.table.hq_canonical?.source,
		);
		if (
			!source.success ||
			source.data.inventory !== "complete" ||
			source.data.storage === "generation" ||
			source.data.distribution !== "assigned" ||
			(expectedRevision !== undefined && expectedRevision !== s.revision) ||
			(ordinal > 0 && ordinal >= s.table.row_count)
		)
			throw refusal();
		const id = await tx
			.selectFrom("lookup_rows")
			.select("hq_row_id")
			.where("project_id", "=", access.scope.projectId)
			.where("table_id", "=", access.tableId)
			.orderBy("order_key")
			.orderBy("id")
			.offset(ordinal)
			.limit(1)
			.executeTakeFirst();
		if (s.table.row_count > 0 && !id?.hq_row_id) throw refusal();
		return {
			scopeDigest: s.scopeDigest,
			tag: s.table.tag,
			revision: s.revision,
			count: s.table.row_count,
			sourceId: id?.hq_row_id,
			remoteId: s.table.hq_remote_id,
			domain: s.table.hq_domain,
			server: s.table.hq_server,
		};
	});
	const domain = read.domain;
	if (!domain || !read.remoteId) throw refusal();
	const target = await getHqCredentials(access.scope.actorId, domain);
	if (!target.ok || target.creds.server !== read.server) throw refusal();
	const lease = processMemoryMeter().open();
	try {
		return await runInLease(lease, async () => {
			const list = await listHqLookupTables(target.creds, domain, {
				cancel: lease.signal,
			});
			if ("success" in list) throw refusal();
			const peers = list.filter((t) => t.tag === read.tag);
			const [table] = peers;
			if (
				peers.length !== 1 ||
				!table ||
				table.id !== read.remoteId ||
				table.isGlobal
			)
				throw refusal();
			// The filtered fixture list and selected detail have distinct HQ permission
			// contracts. Establish live access to both before returning any current row.
			const selected = await inspectSelectedHqRowAt(
				target.creds,
				domain,
				table,
				{ ordinal, total: read.count, id: read.sourceId ?? null },
				lease.signal,
			);
			if ("success" in selected) throw refusal();
			try {
				const detail = selected.row;
				const final = await withAppTx((tx) => lockInventoryScope(tx, access));
				if (
					final.scopeDigest !== read.scopeDigest ||
					final.revision !== read.revision
				)
					throw refusal();
				const text = detail
					? JSON.stringify({
							attributes: detail.itemAttributes,
							fields: detail.fields,
						})
					: null;
				if (text !== null && Buffer.byteLength(text) > 128 * 1024)
					throw new LookupError(
						"storage_limit",
						"This row needs the paged source inventory. You can refresh it in Project data.",
					);
				return {
					ordinal,
					total: read.count,
					revision: read.revision,
					observedAt: new Date().toISOString(),
					text,
				};
			} finally {
				giveBackHeld("text", selected.bytes);
			}
		});
	} finally {
		lease.end();
	}
}
