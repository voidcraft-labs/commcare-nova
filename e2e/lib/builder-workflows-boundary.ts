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
