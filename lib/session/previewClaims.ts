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

/** Previewing as the signed-in member, the worker no persona names. */
export const PREVIEW_AS_ME_WORKER = "me";

export interface PreviewClaims {
	readonly appId: string;
	/** The persona's uuid, or {@link PREVIEW_AS_ME_WORKER}. */
	readonly worker: string;
	/** Claimed case ids in claim order, each once. */
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
 * Append newly claimed ids for this worker of this app. Ids already claimed
 * keep their place; a key that differs from the held one starts a fresh set.
 * Claiming nothing new returns the same reference, so subscribers see no
 * change.
 */
export function addClaims(
	claims: PreviewClaims | undefined,
	appId: string,
	worker: string,
	caseIds: readonly string[],
): PreviewClaims | undefined {
	const held = claimsFor(claims, appId, worker);
	const seen = new Set(held);
	const added: string[] = [];
	for (const caseId of caseIds) {
		if (caseId.length === 0 || seen.has(caseId)) continue;
		seen.add(caseId);
		added.push(caseId);
	}
	if (added.length === 0) return claims;
	return { appId, worker, caseIds: [...held, ...added] };
}
