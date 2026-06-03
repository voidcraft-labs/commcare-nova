import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-utils";
import { getCcz } from "@/lib/store";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const session = await requireSession(req);
	const { id } = await params;
	// Owner-scoped read: the archive is bound to the user who compiled it,
	// so a foreign id resolves under THIS caller's namespace and isn't found
	// — the random UUID is no longer the only thing gating a cross-user read.
	const buffer = await getCcz(id, session.user.id);

	if (!buffer) {
		return new Response("CCZ not found or expired", { status: 404 });
	}

	return new Response(new Uint8Array(buffer), {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": `attachment; filename="app.ccz"`,
			"Content-Length": buffer.length.toString(),
		},
	});
}
