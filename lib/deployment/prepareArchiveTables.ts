import "server-only";
import { ApiError } from "@/lib/apiError";
import {
	type ValidationError,
	validationError,
} from "@/lib/commcare/validator/errors";
import { verifyWorkerChoices } from "@/lib/deployment/workerChoiceProof";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import {
	type ArchiveLookupAccess,
	archiveTableReader,
	type StreamingLookupTable,
} from "@/lib/lookup/archiveRows";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export async function prepareArchiveTables(
	doc: BlueprintDoc,
	snapshot: LookupFixtureDataSnapshot,
	authority: ArchiveLookupAccess | undefined,
) {
	const tables = new Map<LookupTableId, StreamingLookupTable>();
	const issues: ValidationError[] = [];
	if (!snapshot.streamedTables?.size) return { tables, issues };
	if (!authority)
		throw new ApiError(
			"Sign in again to prepare this app’s project data.",
			403,
		);
	for (const definition of snapshot.definitions) {
		const size = snapshot.streamedTables.get(definition.id);
		if (!size) continue;
		const reader = archiveTableReader(authority, definition.id, size.rowCount);
		const checked = await verifyWorkerChoices(doc, definition, reader.rows(), {
			workerBinding: canonicalJsonDigest([
				"all-workers",
				authority.projectId,
				definition.id,
				snapshot.projectRevision,
			]),
			reopenRow: reader.reopenRow,
		});
		for (const issue of checked.issues)
			issues.push(
				validationError(
					"LOOKUP_WORKER_SOURCE_UNAVAILABLE",
					"app",
					`“${definition.name}” cannot supply the ${issue.role} for ${issue.owner}. ${issue.count} ${issue.kind} result(s)${issue.firstPositions.length ? " at row " + issue.firstPositions.join(", ") : ""}. You can review those choices in Project data.`,
					{},
					{ tableId: definition.id, tableName: definition.name },
				),
			);
		tables.set(definition.id, { definition, reader, count: size.rowCount });
	}
	return { tables, issues };
}
