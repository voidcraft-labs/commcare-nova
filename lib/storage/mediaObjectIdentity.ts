/** Final objects and document extracts share a Project/hash lock across
 * extensions. Pending upload keys remain specific to their attempt. */
export function mediaObjectLockIdentity(gcsObjectKey: string): string {
	const match = /^(projects\/[^/]+\/[0-9a-f]{64})(?:\..+)$/.exec(gcsObjectKey);
	return match?.[1] ?? gcsObjectKey;
}
