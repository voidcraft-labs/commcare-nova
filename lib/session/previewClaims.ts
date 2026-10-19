/**
 * The cases one Preview worker has claimed from a search.
 *
 * Choosing a search result on a device posts a claim: HQ creates an open
 * `commcare-case-claim` case the worker owns, with an extension index to
 * the chosen case (`casexml/apps/case/cleanup.py::claim_case`), so the
 * device's next restore holds the chosen case. Preview writes no claim row;
 * it keeps the claimed ids here and every device-scoped read of this worker
 * sends them, so the restore closure seeds each one as the claim's owned
 * extension would (`lib/case-store/sql/compileRestoreScope.ts`).
 *
 * One slot, keyed by the app and the worker. A claim belongs to one worker
 * of one app, and a change of worker drops it, so a map of workers would
 * only keep claims nobody can read. The key check makes a claim of another
 * app or another worker unreadable by construction, even before the store
 * clears it.
 *
 * These reducers are pure; the session store writes through them.
 */

/**
 * The most claims one Preview worker holds and sends. The session keeps the
 * most recent ones, and the server refuses a longer list
 * (`lib/preview/engine/previewAuthorization.ts::previewClaimedCaseIds`), so
 * a worker who chooses more cases than this lets go of the ones chosen
 * longest ago.
 */
export const PREVIEW_CLAIMS_LIMIT = 1000;

/** Previewing as the signed-in member, the worker no persona names. */
export const PREVIEW_AS_ME_WORKER = "me";

export interface PreviewClaims {
	readonly appId: string;
	/** The persona's uuid, or {@link PREVIEW_AS_ME_WORKER}. */
	readonly worker: string;
	/** Claimed case ids in the order of each one's latest claim, each once. */
	readonly caseIds: readonly string[];
}

const NO_CLAIMS: readonly string[] = Object.freeze([]);

/** The worker key of a persona selector. */
export function previewClaimsWorker(personaUuid: string | undefined): string {
	return personaUuid ?? PREVIEW_AS_ME_WORKER;
}

/** The claims this worker of this app holds; none for any other key. */
export function claimsFor(
	claims: PreviewClaims | undefined,
	appId: string | undefined,
	worker: string,
): readonly string[] {
	if (
		claims === undefined ||
		appId === undefined ||
		claims.appId !== appId ||
		claims.worker !== worker
	) {
		return NO_CLAIMS;
	}
	return claims.caseIds;
}

/**
 * Record ids this worker of this app has just claimed. Each claimed id takes
 * the most recent place, a re-claimed one moving there from its earlier
 * place, so the set's order is the order of each id's latest claim; a key
 * that differs from the held one starts a fresh set. The set holds the most
 * recent {@link PREVIEW_CLAIMS_LIMIT} ids, so the ones claimed longest ago
 * give way once it is full. A claim that leaves the order as it was returns
 * the same reference, so subscribers see no change.
 */
export function addClaims(
	claims: PreviewClaims | undefined,
	appId: string,
	worker: string,
	caseIds: readonly string[],
): PreviewClaims | undefined {
	const held = claimsFor(claims, appId, worker);
	const latest = new Set<string>();
	for (const caseId of caseIds) {
		if (caseId.length === 0) continue;
		// Re-inserting moves an id to the end, its latest claim.
		latest.delete(caseId);
		latest.add(caseId);
	}
	if (latest.size === 0) return claims;
	const next = [
		...held.filter((caseId) => !latest.has(caseId)),
		...latest,
	].slice(-PREVIEW_CLAIMS_LIMIT);
	if (
		claims !== undefined &&
		next.length === held.length &&
		next.every((caseId, index) => caseId === held[index])
	) {
		return claims;
	}
	return { appId, worker, caseIds: next };
}
