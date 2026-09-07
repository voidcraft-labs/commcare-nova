/** Only Next Server Action serialization is replaced in the component peer.
 * The real organization client, document gate, and editor own all behavior. */
async function post(path: string, args: unknown) {
	const response = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok)
		throw new Error("Controlled Server Action transport failure");
	return response.json();
}
export function readOrganizationAction(appId: string) {
	return post("/automation-organization", { appId });
}
export function previewAutomationAction(args: unknown) {
	return post("/automation-preview", args);
}
export async function createLocationAction(): Promise<never> {
	throw new Error("Unexpected organization write");
}
export const updateLocationAction = createLocationAction;
export const moveLocationAction = createLocationAction;
export const describeArchiveImpactAction = createLocationAction;
export const setLocationArchivedAction = createLocationAction;
