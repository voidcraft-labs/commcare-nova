/** One-time retirement of private drafts containing unrepairable old evidence.
 * Runtime authoring does not import this operator repair. */
import { sql, type Transaction } from "kysely";
import {
	designArtifactWorkspaceOperationSchema,
	normalizeStoredDesignArtifactWorkspaceOperation,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	type ExistingLookupChoiceSource,
	existingLookupChoiceSourceSchema,
} from "@/lib/agent/design/contract";
import { mapDesignSchemaSlots } from "@/lib/agent/design/identityProjection";
import {
	computeLookupChoiceProjectionAttestation,
	EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
	lookupChoiceAttestationsEqual,
} from "@/lib/agent/design/lookupChoiceAttestation";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, getAppDb } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import {
	readAllLookupDefinitionsInTransaction,
	readLookupFixtureDataInTransaction,
} from "@/lib/lookup/service";

export interface DesignChoiceWorkspaceRepairFinding {
	workspaceId: string;
	designSessionId: string;
	standing: "clean" | "repairable" | "busy" | "superseded" | "reset";
	invalidProofs: number;
}

async function invalidProofs(
	tx: Transaction<AppDatabase>,
	workspaceId: string,
	projectId: string,
): Promise<number> {
	const steps = await tx
		.selectFrom("design_artifact_workspace_steps")
		.select("revision")
		.select(sql<string>`${sql.ref("operation")}::text`.as("operation_text"))
		.where("workspace_id", "=", workspaceId)
		.orderBy("revision")
		.execute();
	const sources = new Map<string, ExistingLookupChoiceSource>();
	for (const step of steps) {
		const operation = normalizeStoredDesignArtifactWorkspaceOperation(
			parsePersistedJsonText(
				step.operation_text,
				`design_artifact_workspace_steps.operation for ${workspaceId} revision ${String(step.revision)}`,
			),
		);
		mapDesignSchemaSlots(
			designArtifactWorkspaceOperationSchema,
			operation,
			EXISTING_LOOKUP_CHOICE_SCHEMA_MARKER,
			(entry) => {
				const source = existingLookupChoiceSourceSchema.parse(entry);
				sources.set(JSON.stringify(source), source);
				return entry;
			},
		);
	}
	if (sources.size === 0) return 0;
	const catalog = await readAllLookupDefinitionsInTransaction(tx, projectId);
	const current = [...sources.values()].flatMap((source) => {
		const table = catalog.definitions.find(
			(entry) => entry.id === source.tableId,
		);
		if (table?.tableRevision !== source.inspection.tableRevision) return [];
		const valueColumn = table.columns.find(
			(column) => column.id === source.valueColumnId,
		);
		const labelColumn = table.columns.find(
			(column) => column.id === source.labelColumnId,
		);
		return valueColumn === undefined || labelColumn === undefined
			? []
			: [{ source, table, valueColumn, labelColumn }];
	});
	if (current.length === 0) return 0;
	const fixture = await readLookupFixtureDataInTransaction(tx, projectId, [
		...new Set(current.map(({ source }) => source.tableId)),
	]);
	return current.filter(
		({ source, table, valueColumn, labelColumn }) =>
			!lookupChoiceAttestationsEqual(
				source.inspection,
				computeLookupChoiceProjectionAttestation({
					tableRevision: source.inspection.tableRevision,
					tableName: table.name,
					valueColumnLabel: valueColumn.label,
					labelColumnLabel: labelColumn.label,
					rows: (fixture.rowsByTable.get(source.tableId) ?? []).map((row) => ({
						rowId: row.id,
						value: row.values[source.valueColumnId],
						label: row.values[source.labelColumnId],
					})),
				}),
			),
	).length;
}

async function inspectWorkspace(
	tx: Transaction<AppDatabase>,
	workspaceId: string,
	execute: boolean,
): Promise<DesignChoiceWorkspaceRepairFinding | null> {
	const workspace = await tx
		.selectFrom("design_artifact_workspaces")
		.select(["design_session_id", "status"])
		.where("id", "=", workspaceId)
		.executeTakeFirst();
	if (workspace === undefined) return null;
	const result = (
		standing: DesignChoiceWorkspaceRepairFinding["standing"],
		count = 0,
	): DesignChoiceWorkspaceRepairFinding => ({
		workspaceId,
		designSessionId: workspace.design_session_id,
		standing,
		invalidProofs: count,
	});
	if (workspace.status !== "open") return result("superseded");
	let session = await tx
		.selectFrom("design_sessions")
		.selectAll()
		.where("id", "=", workspace.design_session_id)
		.executeTakeFirstOrThrow();
	let busy: boolean;
	if (session.app_id !== null) {
		let query = tx
			.selectFrom("apps")
			.select(LEASE_COLUMNS)
			.where("id", "=", session.app_id);
		if (execute) query = query.forUpdate();
		const app = await query.executeTakeFirstOrThrow();
		busy = runLeaseState(leaseView(app)).holderIdentity !== null;
	} else {
		if (execute)
			session = await tx
				.selectFrom("design_sessions")
				.selectAll()
				.where("id", "=", session.id)
				.forUpdate()
				.executeTakeFirstOrThrow();
		// A genesis commit may have moved authority while this repair waited.
		if (session.app_id !== null) return result("busy");
		busy = designSessionLeaseState(session).present;
	}
	if (execute) {
		const locked = await tx
			.selectFrom("design_artifact_workspaces")
			.select("status")
			.where("id", "=", workspaceId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		if (locked.status !== "open") return result("superseded");
	}
	const count = await invalidProofs(tx, workspaceId, session.project_id);
	if (count === 0) return result("clean");
	if (busy) return result("busy", count);
	if (!execute) return result("repairable", count);
	await tx
		.updateTable("design_artifact_workspaces")
		.set({ status: "superseded", updated_at: new Date() })
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	return result("reset", count);
}

export async function scanDesignChoiceWorkspaces(): Promise<
	DesignChoiceWorkspaceRepairFinding[]
> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute(async (tx) => {
			const workspaces = await tx
				.selectFrom("design_artifact_workspaces")
				.select("id")
				.where("status", "=", "open")
				.orderBy("id")
				.execute();
			const findings: DesignChoiceWorkspaceRepairFinding[] = [];
			for (const workspace of workspaces) {
				const finding = await inspectWorkspace(tx, workspace.id, false);
				if (finding !== null) findings.push(finding);
			}
			return findings;
		});
}

/** Reclassify under the same holder/workspace locks used by design writes.
 * Retire only the affected private workspace; preserve its history, identities,
 * immutable design artifacts, and every app/Project data row. */
export async function resetDesignChoiceWorkspace(
	workspaceId: string,
): Promise<DesignChoiceWorkspaceRepairFinding | null> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.execute((tx) => inspectWorkspace(tx, workspaceId, true));
}
