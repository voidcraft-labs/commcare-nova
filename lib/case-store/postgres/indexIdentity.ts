/** Dependency-light identity and lock keys for case-schema expression indexes. */

import { createHash } from "node:crypto";

/** 12 hex chars = 48 bits; fixed width keeps index names bounded. */
const INDEX_SCOPE_TAG_LENGTH = 12;

export function caseSchemaIndexLockScope(
	appId: string,
	caseType: string,
): string {
	return `nova:case-schema-index:${JSON.stringify([appId, caseType])}`;
}

/** Fixed-width identifier-safe hash of one `(app, case type)` scope. */
export function indexScopeTag(appId: string, caseType: string): string {
	return createHash("sha256")
		.update(`${appId} ${caseType}`)
		.digest("hex")
		.slice(0, INDEX_SCOPE_TAG_LENGTH);
}

/** Fixed-width identifier-safe hash of one property name. */
export function propertyIndexTag(property: string): string {
	return createHash("sha256")
		.update(property)
		.digest("hex")
		.slice(0, INDEX_SCOPE_TAG_LENGTH);
}
