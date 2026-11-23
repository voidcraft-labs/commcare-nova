import "server-only";
import {
	readWorkerLookupProjection,
	type WorkerProjectionAccess,
} from "@/lib/deployment/workerLookupProjection";
import type { LookupTableId } from "@/lib/domain/lookupIds";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type { LookupScope } from "@/lib/lookup/types";

/** Only server authentication paths can attach a worker grant. No-grant
 * callers may read installed global rows, including older saved designs. */
export type PreviewLookupScope = LookupScope & {
	worker?: WorkerProjectionAccess;
};
export function readPreviewLookup(
	scope: PreviewLookupScope,
	tableIds: readonly LookupTableId[],
) {
	return scope.worker
		? readWorkerLookupProjection(scope.worker, tableIds)
		: getLookupFixtureData(scope, tableIds);
}
