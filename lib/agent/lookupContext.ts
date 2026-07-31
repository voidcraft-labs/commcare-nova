import "server-only";

import type { LookupTableId } from "@/lib/domain/lookupIds";
import { getLookupDefinitions, getLookupManifest } from "@/lib/lookup/service";
import type {
	LookupDefinitionsSnapshot,
	LookupScope,
} from "@/lib/lookup/types";

/** Read the exact definitions requested by a shared tool. */
export function readToolLookupDefinitions(
	scope: LookupScope,
	tableIds: readonly LookupTableId[],
): Promise<LookupDefinitionsSnapshot> {
	return getLookupDefinitions(scope, tableIds);
}

/**
 * Read a complete rows-free catalog without mixing manifest and definition
 * generations. The manifest supplies the identity set; if the Project clock
 * moves before the definition snapshot, retry once from the new manifest.
 * Persistent churn returns a plain retryable error rather than projecting a
 * catalog assembled from two generations.
 */
export async function readToolLookupCatalog(
	scope: LookupScope,
): Promise<LookupDefinitionsSnapshot> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const manifest = await getLookupManifest(scope);
		const definitions = await getLookupDefinitions(
			scope,
			manifest.tables.map((table) => table.id),
		);
		if (definitions.projectRevision === manifest.projectRevision) {
			return definitions;
		}
	}
	throw new Error(
		"Project data changed while it was loading. Read the data tables again.",
	);
}
