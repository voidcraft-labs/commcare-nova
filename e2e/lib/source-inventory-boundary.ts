import type * as Actions from "@/lib/deployment/managedInventoryActions";

async function request(method: string, args: unknown[]) {
	const response = await fetch(`/native/source-inventory/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok)
		throw new Error("The source-inventory peer did not accept this request");
	return response.json();
}
export const getManagedInventoryStatusAction: typeof Actions.getManagedInventoryStatusAction =
	(...args) => request("status", args);
export const readManagedInventoryAction: typeof Actions.readManagedInventoryAction =
	(...args) => request("read", args);
export const cancelManagedInventoryAction: typeof Actions.cancelManagedInventoryAction =
	(...args) => request("cancel", args);
