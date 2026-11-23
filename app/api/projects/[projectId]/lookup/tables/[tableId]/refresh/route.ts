import { refreshManagedLookupTableAction } from "@/lib/deployment/managedDataActions";

/** Keeping the long source read outside the client Server Action queue lets an
 * editor inspect the committed generation or cancel their refresh as it runs. */
export async function POST(
	request: Request,
	context: { params: Promise<{ projectId: string; tableId: string }> },
) {
	// A cross-origin HTML form cannot set this header. This route grants no
	// cross-origin preflight, including for other Nova hostnames.
	if (
		request.headers.get("x-nova-source-refresh") !== "1" ||
		request.headers.get("sec-fetch-site") === "cross-site"
	) {
		return Response.json(
			{ ok: false, message: "This refresh needs to start from Project data." },
			{ status: 403 },
		);
	}
	const { projectId, tableId } = await context.params;
	return Response.json(
		await refreshManagedLookupTableAction(projectId, tableId),
		{ headers: { "Cache-Control": "no-store" } },
	);
}
