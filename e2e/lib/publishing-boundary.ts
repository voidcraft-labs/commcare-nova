/** Native HTTP replaces only Next's Server Action transport. */
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
export function readDeploymentsAction(appId: string) {
	return post("/publishing/read", { appId });
}
export function refreshDeploymentAction(args: unknown) {
	return post("/publishing/refresh", args);
}
export function getEntryPointLinkAction(args: unknown) {
	return post("/publishing/link", args);
}
export function getLookupManifestAction(args: unknown) {
	return post("/publishing/lookup", args);
}
