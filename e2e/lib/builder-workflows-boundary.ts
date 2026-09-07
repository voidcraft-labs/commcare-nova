/** The Next Server Action transport is outside this native authoring peer.
 * No organization or case-data operation is part of these gestures. */
export async function readOrganizationAction(): Promise<never> {
	throw new Error("Unexpected organization read in case-target evidence");
}
export const createLocationAction = readOrganizationAction;
export const describeArchiveImpactAction = readOrganizationAction;
export const moveLocationAction = readOrganizationAction;
export const setLocationArchivedAction = readOrganizationAction;
export const updateLocationAction = readOrganizationAction;

export async function getAllLookupDefinitionsAction(): Promise<never> {
	throw new Error("Unexpected lookup Server Action in native module settings");
}

/** The field inspector's convert-type dialog reaches the case store through
 * this Server Action. The inspector fixtures never convert a kind, so the
 * boundary stands in for the whole case-data binding module and keeps the
 * store, auth, and MCP server graph out of the browser bundle. */
export async function conversionImpactAction(): Promise<never> {
	throw new Error(
		"Unexpected conversion impact read in native field inspector",
	);
}
