/** Stable advisory-lock identity shared by schema and case-row writers. */
export function caseSchemaIndexLockScope(
	appId: string,
	caseType: string,
): string {
	return `nova:case-schema-index:${JSON.stringify([appId, caseType])}`;
}
