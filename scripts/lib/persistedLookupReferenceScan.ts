/** Persisted lookup audit. PostgreSQL owns the read-only repeatable snapshot. */
import { type Kysely, type Selectable, sql, type Transaction } from "kysely";
import { readStoredLookupReferenceTargets } from "@/lib/db/lookupReferenceEdges";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import type { AppDatabase, AppsTable } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	buildLookupReferenceScanReport,
	type LookupReferenceScanApp,
	type LookupReferenceScanObservation,
	type LookupReferenceScanReport,
	type StoredLookupReferenceRead,
	type StructuralLookupReferenceRead,
} from "./lookupReferenceEdgeScan";

type PersistedAppRow = Pick<
	Selectable<AppsTable>,
	"id" | "project_id" | "app_name" | "connect_type" | "logo" | "deleted_at"
> & {
	readonly case_types_text: string | null;
	readonly localization_text: string | null;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appIdentity(row: PersistedAppRow): LookupReferenceScanApp {
	return {
		appId: row.id,
		projectId: row.project_id,
		appName: row.app_name,
		deletedAt: row.deleted_at?.toISOString() ?? null,
	};
}

/**
 * Assemble and hydrate through the same stored-blueprint boundary production
 * uses, then invoke the shared production extractor. The extractor's default
 * registry is intentional: a newly registered carrier kind must automatically
 * become visible to this durable inspector.
 */
async function readStructuralTargets(
	tx: Transaction<AppDatabase>,
	row: PersistedAppRow,
): Promise<StructuralLookupReferenceRead> {
	let entityRows: PersistedEntityRowText[];
	try {
		entityRows = (await tx
			.selectFrom("blueprint_entities")
			.select(["uuid", "kind", "parent_uuid", "ordinal"])
			.select(
				sql<string>`${sql.ref("blueprint_entities.data")}::text`.as(
					"data_text",
				),
			)
			.where("app_id", "=", row.id)
			.execute()) as PersistedEntityRowText[];
	} catch (error) {
		return {
			kind: "error",
			stage: "read-blueprint-rows",
			message: errorMessage(error),
		};
	}

	let doc: ReturnType<typeof hydratePersistedBlueprint>;
	try {
		const persisted = assemblePersistedBlueprintJsonText(
			row.id,
			{
				app_name: row.app_name,
				connect_type: row.connect_type,
				case_types_text: row.case_types_text,
				localization_text: row.localization_text,
				logo: row.logo,
			},
			entityRows,
		);
		doc = hydratePersistedBlueprint(persisted);
	} catch (error) {
		return {
			kind: "unassemblable",
			message: errorMessage(error),
		};
	}

	try {
		return {
			kind: "ok",
			targets: extractLookupReferenceTargets(doc),
		};
	} catch (error) {
		return {
			kind: "error",
			stage: "extract-structural-targets",
			message: errorMessage(error),
		};
	}
}

async function readStoredTargets(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<StoredLookupReferenceRead> {
	try {
		return {
			kind: "ok",
			targets: await readStoredLookupReferenceTargets(tx, appId),
		};
	} catch (error) {
		return {
			kind: "error",
			stage: "read-stored-targets",
			message: errorMessage(error),
		};
	}
}

async function inspectApp(
	tx: Transaction<AppDatabase>,
	row: PersistedAppRow,
): Promise<LookupReferenceScanObservation> {
	// Run both reads even if assembly fails so one bad blueprint cannot hide a
	// separate stored-edge integrity/operational failure for the same app.
	const structural = await readStructuralTargets(tx, row);
	const stored = await readStoredTargets(tx, row.id);
	return { app: appIdentity(row), structural, stored };
}

export async function scanPersistedLookupReferences(
	db: Kysely<AppDatabase>,
): Promise<LookupReferenceScanReport> {
	const observations = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			// Postgres enforces the inspector's no-write promise. The repeatable-
			// read snapshot also prevents a concurrent app commit from manufacturing
			// a cross-version structural/edge mismatch.
			const appRows = await tx
				.selectFrom("apps")
				.select([
					"id",
					"project_id",
					"app_name",
					"connect_type",
					"logo",
					"deleted_at",
				])
				.select(
					sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
						"case_types_text",
					),
				)
				.select(
					sql<string | null>`${sql.ref("apps.localization")}::text`.as(
						"localization_text",
					),
				)
				.orderBy("id", "asc")
				.execute();
			const results: LookupReferenceScanObservation[] = [];
			// Deliberately sequential: this is an operator audit over one shared
			// snapshot, not a fan-out workload. It keeps connection/memory pressure
			// bounded on developer machines and production alike.
			for (const row of appRows) {
				results.push(await inspectApp(tx, row));
			}
			return results;
		});

	return buildLookupReferenceScanReport(observations);
}
