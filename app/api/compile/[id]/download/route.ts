import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-utils";
import { getCcz } from "@/lib/store";

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	await requireSession(req);
	const { id } = await params;
	const buffer = await getCcz(id);

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
