import type * as Lookup from "@/lib/lookup/actions";
import type * as Organization from "@/lib/organization/actions";
import type * as Cases from "@/lib/preview/engine/caseDataBinding";

// Only Next's compiled Server Action transport is replaced. The real catalog,
// organization client, mutation gate, doc store, and Users UI stay mounted.
async function request(method: string, args: unknown[]) {
	const response = await fetch(`/native/users/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error("Users transport peer failed");
	return response.json();
}
export const getAllLookupDefinitionsAction: typeof Lookup.getAllLookupDefinitionsAction =
	async (...args) => request("catalog", args);
export const readOrganizationAction: typeof Organization.readOrganizationAction =
	async (...args) => request("organization", args);
export const countCasesOwnedByAction: typeof Cases.countCasesOwnedByAction =
	async (...args) => request("count", args);
const unexpectedWrite = async () => {
	throw new Error("Unexpected organization write in Users fixture");
};
export const createLocationAction: typeof Organization.createLocationAction =
	unexpectedWrite;
export const updateLocationAction: typeof Organization.updateLocationAction =
	unexpectedWrite;
export const moveLocationAction: typeof Organization.moveLocationAction =
	unexpectedWrite;
export const describeArchiveImpactAction: typeof Organization.describeArchiveImpactAction =
	unexpectedWrite;
export const setLocationArchivedAction: typeof Organization.setLocationArchivedAction =
	unexpectedWrite;
