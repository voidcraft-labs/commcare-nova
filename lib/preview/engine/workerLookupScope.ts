import "server-only";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";

/** A device read admits all of its requested tables as one bounded snapshot. */
export function readPreviewLookup(
	scope: LookupScope,
	tableIds: readonly LookupTableId[],
) {
	return getLookupFixtureData(scope, tableIds, "device");
}
