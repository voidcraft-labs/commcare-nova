import "server-only";

import { sql, type Transaction } from "kysely";
import type { DesignArtifactWriteAuthority } from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContractV2Raw,
	appDesignContractSchema,
	appDesignContractV2BaseSchema,
	type ChangedLookupColumnRef,
	type ChangedLookupRowRef,
} from "@/lib/agent/design/contract";
import {
	designArtifactEnvelopeSchema,
	verifyArtifactEnvelope,
} from "@/lib/agent/design/envelope";
import { sourceRefKey } from "@/lib/agent/design/evidence";
import { type DesignId, designIdSchema } from "@/lib/agent/design/ids";
import {
	computeLookupChoiceProjectionAttestation,
	lookupChoiceAttestationsEqual,
} from "@/lib/agent/design/lookupChoiceAttestation";
import {
	type DesignLookupBinding,
	type DesignLookupMaterializationPayload,
	designLookupMaterializationPayloadSchema,
} from "@/lib/agent/design/lookupMaterializationTypes";
import { persistedSourcePackageSchema } from "@/lib/agent/design/sourcePackage";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import {
	lookupRowValuesSchema,
	parseLookupRevision,
} from "@/lib/lookup/schema";
import type {
	LookupAuthoringBatchInput,
	LookupAuthoringCell,
	LookupAuthoringColumnOperation,
	LookupAuthoringRowOperation,
	LookupColumnId,
	LookupRevision,
	LookupRowId,
	LookupTableId,
} from "@/lib/lookup/types";
import {
	lockLookupProjectState,
	lookupTableRevisions,
} from "@/lib/lookup/writerTransaction";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface DesignLookupMaterializationRecord {
	readonly id: string;
	readonly resultDigest: string;
	readonly payload: DesignLookupMaterializationPayload;
	readonly createdAt: Date;
}

export class DesignLookupMaterializationError extends Error {
	readonly name = "DesignLookupMaterializationError";
}

const acceptedContractEnvelopeSchema = designArtifactEnvelopeSchema(
	"design-contract",
	appDesignContractSchema,
);

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function existingColumnId(ref: ChangedLookupColumnRef): LookupColumnId | null {
	return ref.kind === "existing-column" ? ref.columnId : null;
}

function existingRowId(ref: ChangedLookupRowRef): LookupRowId | null {
	return ref.kind === "existing-row" ? ref.rowId : null;
}

function cellsForExisting(
	cells: readonly {
		readonly column: ChangedLookupColumnRef;
		readonly value: string | number;
	}[],
): LookupAuthoringCell[] {
	return cells.map((cell) =>
		cell.column.kind === "existing-column"
			? { columnId: cell.column.columnId, value: cell.value }
			: { columnKey: cell.column.columnId, value: cell.value },
	);
}

function translateLookupBatch(
	contract: AppDesignContractV2Raw,
): LookupAuthoringBatchInput | null {
	const createTables: NonNullable<LookupAuthoringBatchInput["createTables"]> =
		[];
	const updateTables: NonNullable<LookupAuthoringBatchInput["updateTables"]> =
		[];
	for (const table of contract.lookupTables) {
		if (table.kind === "create") {
			createTables.push({
				key: table.id,
				name: table.name,
				tag: table.tag,
				columns: table.columns.map((column) => ({
					key: column.id,
					wireName: column.wireName,
					label: column.label,
					dataType: column.dataType,
				})),
				rows: table.rows.map((row) => ({
					key: row.id,
					cells: row.cells.map((cell) => ({
						columnKey: cell.columnId,
						value: cell.value,
					})),
				})),
			});
			continue;
		}

		const columnOperations: LookupAuthoringColumnOperation[] = [];
		const rowOperations: LookupAuthoringRowOperation[] = [];
		const update: NonNullable<
			LookupAuthoringBatchInput["updateTables"]
		>[number] = {
			tableId: table.tableId,
			expectedTableRevision: table.expectedTableRevision,
		};
		for (const operation of table.operations) {
			switch (operation.kind) {
				case "update-table":
					if (operation.name !== undefined) update.name = operation.name;
					if (operation.tag !== undefined) update.tag = operation.tag;
					break;
				case "add-column": {
					const afterColumnId =
						operation.after === undefined
							? undefined
							: existingColumnId(operation.after);
					columnOperations.push({
						kind: "add",
						key: operation.column.id,
						column: {
							wireName: operation.column.wireName,
							label: operation.column.label,
							dataType: operation.column.dataType,
						},
						...(operation.after === undefined
							? {}
							: afterColumnId !== null
								? { afterColumnId }
								: { afterColumnKey: operation.after.columnId }),
					});
					break;
				}
				case "update-column":
					if (
						operation.label !== undefined ||
						operation.wireName !== undefined
					) {
						columnOperations.push({
							kind: "update",
							columnId: operation.columnId,
							...(operation.label === undefined
								? {}
								: { label: operation.label }),
							...(operation.wireName === undefined
								? {}
								: { wireName: operation.wireName }),
						});
					}
					if (operation.dataType !== undefined) {
						columnOperations.push({
							kind: "retype",
							columnId: operation.columnId,
							dataType: operation.dataType,
						});
					}
					break;
				case "move-column": {
					const columnId = existingColumnId(operation.column);
					const afterColumnId =
						operation.after === undefined
							? null
							: existingColumnId(operation.after);
					columnOperations.push({
						kind: "move",
						...(columnId === null
							? { columnKey: operation.column.columnId }
							: { columnId }),
						...(operation.after === undefined || afterColumnId !== null
							? { afterColumnId }
							: { afterColumnKey: operation.after.columnId }),
					});
					break;
				}
				case "remove-column":
					columnOperations.push({
						kind: "remove",
						columnId: operation.columnId,
					});
					break;
				case "add-row": {
					const afterRowId =
						operation.after === undefined
							? undefined
							: existingRowId(operation.after);
					rowOperations.push({
						kind: "add",
						key: operation.rowId,
						cells: cellsForExisting(operation.cells),
						...(operation.after === undefined
							? {}
							: afterRowId !== null
								? { afterRowId }
								: { afterRowKey: operation.after.rowId }),
					});
					break;
				}
				case "update-row":
					rowOperations.push({
						kind: "update",
						rowId: operation.rowId,
						cells: cellsForExisting(operation.cells),
					});
					break;
				case "move-row": {
					const rowId = existingRowId(operation.row);
					const afterRowId =
						operation.after === undefined
							? null
							: existingRowId(operation.after);
					rowOperations.push({
						kind: "move",
						...(rowId === null ? { rowKey: operation.row.rowId } : { rowId }),
						...(operation.after === undefined || afterRowId !== null
							? { afterRowId }
							: { afterRowKey: operation.after.rowId }),
					});
					break;
				}
				case "remove-row":
					rowOperations.push({ kind: "remove", rowId: operation.rowId });
					break;
				case "replace-rows":
					update.replaceRows = operation.rows.map((row) => ({
						key: row.id,
						cells: cellsForExisting(row.cells),
					}));
					break;
			}
		}
		if (columnOperations.length > 0) update.columnOperations = columnOperations;
		if (rowOperations.length > 0) update.rowOperations = rowOperations;
		updateTables.push(update);
	}
	if (createTables.length === 0 && updateTables.length === 0) return null;
	return { createTables, updateTables };
}

function collectChoiceSources(contract: AppDesignContractV2Raw) {
	return [
		...contract.records.flatMap((record) =>
			record.properties.flatMap((property) =>
				property.choiceSource === undefined ? [] : [property.choiceSource],
			),
		),
		...contract.workflows.flatMap((workflow) =>
			workflow.inputs.flatMap((input) =>
				input.choiceSource === undefined ? [] : [input.choiceSource],
			),
		),
	];
}

async function assertExistingChoiceSourcesCurrentAndConstructible(
	tx: Transaction<AppDatabase>,
	projectId: string,
	contract: AppDesignContractV2Raw,
): Promise<void> {
	const changedTableIds = new Set(
		contract.lookupTables.flatMap((table) =>
			table.kind === "modify-existing" ? [table.tableId] : [],
		),
	);
	for (const source of collectChoiceSources(contract)) {
		if (source.kind !== "existing-project-lookup") continue;
		const table = await tx
			.selectFrom("lookup_tables")
			.selectAll()
			.where("project_id", "=", projectId)
			.where("id", "=", source.tableId)
			.executeTakeFirst();
		if (table === undefined) {
			throw new DesignLookupMaterializationError(
				"An existing lookup table accepted by the design is no longer available in this Project. Reopen the design before construction.",
			);
		}
		const revisions = lookupTableRevisions(table);
		if (
			!changedTableIds.has(source.tableId) &&
			revisions.tableRevision !== source.inspection.tableRevision
		) {
			throw new DesignLookupMaterializationError(
				"Project lookup data changed after its reviewed inspection. Reopen the design before construction.",
			);
		}
		const columns = await tx
			.selectFrom("lookup_columns")
			.select(["id", "label"])
			.where("project_id", "=", projectId)
			.where("table_id", "=", source.tableId)
			.where("id", "in", [source.valueColumnId, source.labelColumnId])
			.execute();
		if (
			!columns.some((column) => column.id === source.valueColumnId) ||
			!columns.some((column) => column.id === source.labelColumnId)
		) {
			throw new DesignLookupMaterializationError(
				"An existing lookup choice column accepted by the design is no longer available. Reopen the design before construction.",
			);
		}
		const storedRows = await tx
			.selectFrom("lookup_rows")
			.select(["id", "values"])
			.where("project_id", "=", projectId)
			.where("table_id", "=", source.tableId)
			.orderBy("order_key", "asc")
			.orderBy("id", "asc")
			.execute();
		const valueColumn = columns.find(
			(column) => column.id === source.valueColumnId,
		);
		const labelColumn = columns.find(
			(column) => column.id === source.labelColumnId,
		);
		if (valueColumn === undefined || labelColumn === undefined)
			throw new DesignLookupMaterializationError(
				"An existing lookup choice column accepted by the design is no longer available. Reopen the design before construction.",
			);
		const currentInspection = computeLookupChoiceProjectionAttestation({
			tableRevision: revisions.tableRevision,
			tableName: table.name,
			valueColumnLabel: valueColumn.label,
			labelColumnLabel: labelColumn.label,
			rows: storedRows.map((row) => {
				const cells = lookupRowValuesSchema.parse(row.values);
				return {
					rowId: row.id,
					value: cells[source.valueColumnId],
					label: cells[source.labelColumnId],
				};
			}),
		});
		if (
			!changedTableIds.has(source.tableId) &&
			!lookupChoiceAttestationsEqual(currentInspection, source.inspection)
		)
			throw new DesignLookupMaterializationError(
				"The reviewed existing lookup choice attestation no longer matches the Project table. Reopen the design before construction.",
			);
		if (
			currentInspection.invalidValueCount > 0 ||
			currentInspection.blankLabelCount > 0 ||
			currentInspection.distinctValueCount < 2 ||
			currentInspection.duplicateValueCount > 0
		) {
			throw new DesignLookupMaterializationError(
				"The materialized existing lookup source does not provide two or more unique nonblank saved values with nonblank labels. Reopen the design before construction.",
			);
		}
	}
}

function materializationRequired(contract: AppDesignContractV2Raw): boolean {
	return (
		contract.lookupTables.length > 0 ||
		collectChoiceSources(contract).length > 0
	);
}

function materializedEvidenceRefs(contract: AppDesignContractV2Raw) {
	return contract.lookupTables.flatMap((table) => [
		...(table.kind === "create"
			? table.rowEvidence.sourceRefs
			: [
					...table.authorization.sourceRefs,
					...table.operations.flatMap((operation) => {
						switch (operation.kind) {
							case "add-row":
							case "update-row":
							case "replace-rows":
								return operation.rowEvidence.sourceRefs;
							default:
								return [];
						}
					}),
				]),
	]);
}

async function readRecordInTransaction(
	tx: Transaction<AppDatabase>,
	designRevisionId: string,
): Promise<DesignLookupMaterializationRecord | null> {
	const row = await tx
		.selectFrom("design_lookup_materializations")
		.select(["id", "result_digest", "created_at"])
		.select((eb) => eb.cast<string>("mapping", "text").as("mapping_text"))
		.where("design_revision_id", "=", designRevisionId)
		.executeTakeFirst();
	if (row === undefined) return null;
	const payload = designLookupMaterializationPayloadSchema.parse(
		parsePersistedJsonText(
			row.mapping_text,
			`design_lookup_materializations.mapping for revision ${designRevisionId}`,
		),
	);
	const digest = canonicalJsonDigest(payload);
	if (digest !== row.result_digest) {
		throw new DesignLookupMaterializationError(
			"A stored design lookup materialization disagrees with its result digest.",
		);
	}
	return {
		id: row.id,
		resultDigest: row.result_digest,
		payload,
		createdAt: row.created_at,
	};
}

async function currentTableStates(
	tx: Transaction<AppDatabase>,
	projectId: string,
	tableIds: readonly LookupTableId[],
): Promise<DesignLookupMaterializationPayload["tables"]> {
	const states = [];
	for (const tableId of [...tableIds].sort(compareAscii)) {
		const table = await tx
			.selectFrom("lookup_tables")
			.select(["definition_revision", "rows_revision"])
			.where("project_id", "=", projectId)
			.where("id", "=", tableId)
			.forShare()
			.executeTakeFirst();
		if (table === undefined) {
			throw new DesignLookupMaterializationError(
				"A lookup table accepted by the design is no longer available in this Project. Reopen the design before construction.",
			);
		}
		const columns = await tx
			.selectFrom("lookup_columns")
			.select("id")
			.where("project_id", "=", projectId)
			.where("table_id", "=", tableId)
			.orderBy("order_key", "asc")
			.orderBy("id", "asc")
			.execute();
		const definitionRevision = parseLookupRevision(table.definition_revision);
		const rowsRevision = parseLookupRevision(table.rows_revision);
		states.push({
			tableId,
			definitionRevision,
			rowsRevision,
			tableRevision:
				BigInt(definitionRevision) >= BigInt(rowsRevision)
					? definitionRevision
					: rowsRevision,
			columnIds: columns.map((column) => lookupColumnIdSchema.parse(column.id)),
		});
	}
	return states;
}

async function assertStoredRecordCurrent(
	tx: Transaction<AppDatabase>,
	record: DesignLookupMaterializationRecord,
): Promise<void> {
	const current = await currentTableStates(
		tx,
		record.payload.projectId,
		record.payload.tables.map((table) => table.tableId),
	);
	if (
		canonicalJsonDigest(current) !== canonicalJsonDigest(record.payload.tables)
	) {
		throw new DesignLookupMaterializationError(
			"Project data changed after this design was accepted. Reopen the design so Nova can review the current table state.",
		);
	}
}

/** Sequence-one revalidation. The genesis transaction calls this after its
 * canonical write tail has locked and projected the lookup dependencies but
 * before temporary protections are removed or anything commits. */
export async function assertDesignLookupMaterializationCurrentInTransaction(
	tx: Transaction<AppDatabase>,
	args: {
		readonly designSessionId: string;
		readonly designRevisionId: string;
		readonly designRevisionDigest: string;
		readonly projectId: string;
	},
): Promise<void> {
	const record = await readRecordInTransaction(tx, args.designRevisionId);
	if (record === null) return;
	if (
		record.payload.designRevisionId !== args.designRevisionId ||
		record.payload.designRevisionDigest !== args.designRevisionDigest ||
		record.payload.projectId !== args.projectId
	) {
		throw new DesignLookupMaterializationError(
			"The genesis lookup receipt does not match the accepted design lineage.",
		);
	}
	const protection = await tx
		.selectFrom("design_lookup_protections")
		.select("id")
		.where("materialization_id", "=", record.id)
		.executeTakeFirst();
	if (record.payload.tables.length > 0 && protection === undefined) {
		throw new DesignLookupMaterializationError(
			"The accepted design's Project-data protection ended before app genesis.",
		);
	}
	await assertStoredRecordCurrent(tx, record);
}

function bindingMap(bindings: readonly DesignLookupBinding[]) {
	return new Map(bindings.map((binding) => [binding.designId, binding]));
}

function requireBinding(
	bindings: ReadonlyMap<string, DesignLookupBinding>,
	designId: DesignId,
	kind: DesignLookupBinding["kind"],
): DesignLookupBinding {
	const binding = bindings.get(designId);
	if (binding === undefined || binding.kind !== kind) {
		throw new DesignLookupMaterializationError(
			`Accepted lookup identity ${designId} did not materialize as ${kind}.`,
		);
	}
	return binding;
}

async function releaseSupersededLookupProtectionsInTransaction(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
	keepMaterializationId?: string,
): Promise<void> {
	let receiptIds = tx
		.selectFrom("design_lookup_materializations")
		.select("id")
		.where("design_session_id", "=", designSessionId);
	if (keepMaterializationId !== undefined)
		receiptIds = receiptIds.where("id", "!=", keepMaterializationId);
	await tx
		.deleteFrom("design_lookup_protections")
		.where("materialization_id", "in", receiptIds)
		.execute();
}

/**
 * Materialize the exact accepted v2 Project-data intent before BuildPlan
 * derivation. Draft/review calls never reach this seam. The receipt's unique
 * revision key is the lost-response idempotency fence.
 */
export async function ensureAcceptedLookupMaterialization(args: {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly contract: AppDesignContractV2Raw;
	readonly authority: DesignArtifactWriteAuthority;
}): Promise<DesignLookupMaterializationRecord | null> {
	return withAppTx(async (tx) => {
		await assertDesignSessionRunAuthorityInTransaction(tx, {
			designSessionId: args.designSessionId,
			actorUserId: args.authority.actorUserId,
			expectedProjectId: args.authority.expectedProjectId,
			holder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
			},
		});
		const accepted = await tx
			.selectFrom("design_revisions")
			.select([
				"design_session_id",
				"artifact_digest",
				"contract_digest",
				"lifecycle",
				"source_package_digest",
			])
			.select(
				sql<string>`${sql.ref("design_revisions.envelope")}::text`.as(
					"envelope_text",
				),
			)
			.where("id", "=", args.designRevisionId)
			.executeTakeFirst();
		if (
			accepted === undefined ||
			accepted.design_session_id !== args.designSessionId ||
			accepted.lifecycle !== "accepted" ||
			accepted.artifact_digest !== args.designRevisionDigest
		) {
			throw new DesignLookupMaterializationError(
				"Project data can materialize only from the exact accepted Design Contract revision.",
			);
		}
		const acceptedEnvelope = acceptedContractEnvelopeSchema.parse(
			parsePersistedJsonText(
				accepted.envelope_text,
				`design_revisions.envelope for accepted lookup revision ${args.designRevisionId}`,
			),
		);
		verifyArtifactEnvelope(acceptedEnvelope);
		const persistedContractDigest = canonicalJsonDigest(
			acceptedEnvelope.payload,
		);
		if (
			acceptedEnvelope.artifactId !== args.designRevisionId ||
			acceptedEnvelope.designSessionId !== args.designSessionId ||
			acceptedEnvelope.artifactDigest !== args.designRevisionDigest ||
			acceptedEnvelope.sourcePackageDigest !== accepted.source_package_digest ||
			persistedContractDigest !== accepted.contract_digest ||
			canonicalJsonDigest(args.contract) !== persistedContractDigest
		) {
			throw new DesignLookupMaterializationError(
				"Project data can materialize only from the exact persisted accepted Design Contract.",
			);
		}
		/* Execute the persisted, digest-verified contract rather than trusting the
		 * caller's equivalent projection beyond the equality proof above. */
		const contract = appDesignContractV2BaseSchema.parse(
			acceptedEnvelope.payload,
		);
		if (!materializationRequired(contract)) {
			await releaseSupersededLookupProtectionsInTransaction(
				tx,
				args.designSessionId,
			);
			return null;
		}
		const sourceRow = await tx
			.selectFrom("design_source_packages")
			.select(
				sql<string>`${sql.ref("design_source_packages.payload")}::text`.as(
					"payload_text",
				),
			)
			.where("design_session_id", "=", args.designSessionId)
			.where("package_digest", "=", accepted.source_package_digest)
			.executeTakeFirst();
		if (sourceRow === undefined) {
			throw new DesignLookupMaterializationError(
				"The accepted design's source package is unavailable for Project-data authorization.",
			);
		}
		const sourcePackage = persistedSourcePackageSchema.parse(
			parsePersistedJsonText(
				sourceRow.payload_text,
				`design_source_packages.payload for ${accepted.source_package_digest}`,
			),
		);
		const citable = new Set(
			[
				...sourcePackage.sources,
				...sourcePackage.claims.flatMap((claim) => claim.sourceRefs),
			].map(sourceRefKey),
		);
		for (const ref of materializedEvidenceRefs(contract)) {
			if (!citable.has(sourceRefKey(ref))) {
				throw new DesignLookupMaterializationError(
					"A Project-data change cites evidence outside the accepted design's source package.",
				);
			}
		}
		const prior = await readRecordInTransaction(tx, args.designRevisionId);
		if (prior !== null) {
			if (
				prior.payload.designRevisionDigest !== args.designRevisionDigest ||
				prior.payload.projectId !== args.authority.expectedProjectId
			) {
				throw new DesignLookupMaterializationError(
					"The accepted revision's stored Project-data receipt belongs to different lineage.",
				);
			}
			await assertStoredRecordCurrent(tx, prior);
			await releaseSupersededLookupProtectionsInTransaction(
				tx,
				args.designSessionId,
				prior.id,
			);
			return prior;
		}

		const role = await projectRoleForInTransaction(
			tx,
			args.authority.actorUserId,
			args.authority.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new DesignLookupMaterializationError(
				"You no longer have edit access to this design's Project.",
			);
		}
		const batch = translateLookupBatch(contract);
		const batchReceipt =
			batch === null
				? null
				: await applyLookupAuthoringBatchInTransaction(
						tx,
						{
							projectId: args.authority.expectedProjectId,
							actorId: args.authority.actorUserId,
							role,
						},
						batch,
					);
		const projectState =
			batchReceipt === null
				? await lockLookupProjectState(tx, args.authority.expectedProjectId)
				: null;
		await assertExistingChoiceSourcesCurrentAndConstructible(
			tx,
			args.authority.expectedProjectId,
			contract,
		);

		const bindings: DesignLookupBinding[] = [];
		for (const table of batchReceipt?.tables ?? []) {
			if (table.key !== undefined) {
				bindings.push({
					kind: "lookup-table",
					designId: designIdSchema.parse(table.key),
					lookupId: table.tableId,
				});
			}
			for (const column of table.columnIds) {
				bindings.push({
					kind: "lookup-column",
					designId: designIdSchema.parse(column.key),
					lookupId: column.id,
				});
			}
			for (const row of table.rowIds) {
				bindings.push({
					kind: "lookup-row",
					designId: designIdSchema.parse(row.key),
					lookupId: row.id,
				});
			}
		}
		bindings.sort(
			(left, right) =>
				compareAscii(left.designId, right.designId) ||
				compareAscii(left.kind, right.kind),
		);
		const bindingsByDesignId = bindingMap(bindings);
		const tableIds = new Set<LookupTableId>();
		const explicitlyProtectedColumns = new Map<
			LookupTableId,
			Set<LookupColumnId>
		>();
		const protectColumn = (
			tableId: LookupTableId,
			columnId: LookupColumnId,
		) => {
			tableIds.add(tableId);
			const columns = explicitlyProtectedColumns.get(tableId) ?? new Set();
			columns.add(columnId);
			explicitlyProtectedColumns.set(tableId, columns);
		};
		for (const table of contract.lookupTables) {
			if (table.kind === "create") {
				const tableBinding = requireBinding(
					bindingsByDesignId,
					table.id,
					"lookup-table",
				);
				const tableId = lookupTableIdSchema.parse(tableBinding.lookupId);
				tableIds.add(tableId);
				for (const column of table.columns) {
					const columnBinding = requireBinding(
						bindingsByDesignId,
						column.id,
						"lookup-column",
					);
					protectColumn(
						tableId,
						lookupColumnIdSchema.parse(columnBinding.lookupId),
					);
				}
			} else {
				tableIds.add(table.tableId);
			}
		}
		for (const source of collectChoiceSources(contract)) {
			if (source.kind === "existing-project-lookup") {
				protectColumn(source.tableId, source.valueColumnId);
				protectColumn(source.tableId, source.labelColumnId);
			} else {
				const tableBinding = requireBinding(
					bindingsByDesignId,
					source.tableId,
					"lookup-table",
				);
				const valueBinding = requireBinding(
					bindingsByDesignId,
					source.valueColumnId,
					"lookup-column",
				);
				const labelBinding = requireBinding(
					bindingsByDesignId,
					source.labelColumnId,
					"lookup-column",
				);
				protectColumn(
					lookupTableIdSchema.parse(tableBinding.lookupId),
					lookupColumnIdSchema.parse(valueBinding.lookupId),
				);
				protectColumn(
					lookupTableIdSchema.parse(tableBinding.lookupId),
					lookupColumnIdSchema.parse(labelBinding.lookupId),
				);
			}
		}
		const tables = await currentTableStates(
			tx,
			args.authority.expectedProjectId,
			[...tableIds],
		);
		/* A modify-existing intent reviewed the whole resulting table. Protect
		 * every resulting column until genesis, not just columns already named
		 * by a choice source. */
		for (const intent of contract.lookupTables) {
			if (intent.kind !== "modify-existing") continue;
			const table = tables.find(
				(candidate) => candidate.tableId === intent.tableId,
			);
			if (table === undefined) continue;
			for (const columnId of table.columnIds)
				protectColumn(intent.tableId, columnId);
		}
		const payload = designLookupMaterializationPayloadSchema.parse({
			schemaVersion: 1,
			designRevisionId: args.designRevisionId,
			designRevisionDigest: args.designRevisionDigest,
			projectId: args.authority.expectedProjectId,
			projectRevision:
				batchReceipt?.projectRevision ??
				parseLookupRevision(projectState?.revision ?? "0"),
			bindings,
			tables,
		});
		const resultDigest = canonicalJsonDigest(payload);
		const id = crypto.randomUUID();
		await tx
			.insertInto("design_lookup_materializations")
			.values({
				id,
				design_session_id: args.designSessionId,
				design_revision_id: args.designRevisionId,
				design_revision_digest: args.designRevisionDigest,
				project_id: args.authority.expectedProjectId,
				project_revision: payload.projectRevision as LookupRevision,
				result_digest: resultDigest,
				mapping: JSON.stringify(payload),
				created_by_run_id: args.authority.runId,
			})
			.execute();
		const protectionRows = tables.flatMap((table) => [
			{
				materialization_id: id,
				project_id: args.authority.expectedProjectId,
				table_id: table.tableId,
				column_id: null,
			},
			...[...(explicitlyProtectedColumns.get(table.tableId) ?? [])]
				.sort(compareAscii)
				.map((columnId) => ({
					materialization_id: id,
					project_id: args.authority.expectedProjectId,
					table_id: table.tableId,
					column_id: columnId,
				})),
		]);
		if (protectionRows.length > 0) {
			await tx
				.insertInto("design_lookup_protections")
				.values(protectionRows)
				.execute();
		}
		await releaseSupersededLookupProtectionsInTransaction(
			tx,
			args.designSessionId,
			id,
		);
		return { id, resultDigest, payload, createdAt: new Date() };
	});
}
