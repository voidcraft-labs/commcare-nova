import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { preparePlaceWorkbook } from "@/lib/deployment/placeWorkbook";
import { deploymentTargetSchema } from "@/lib/deployment/types";

export async function POST(req: Request) {
	try {
		const { session, user } = await requireSession(req);
		const input = deploymentTargetSchema.safeParse(await req.json());
		if (!input.success)
			throw new ApiError(
				"Choose a current app and project space in Publish.",
				400,
			);
		const { appId, ...target } = input.data;
		const artifact = await preparePlaceWorkbook(
			{ userId: user.id, grant: { kind: "session", sessionId: session.id } },
			appId,
			target,
			req.signal,
		);
		return Response.json(
			{ artifact },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return handleApiError(
			error instanceof Error
				? error
				: new Error("Place workbook preparation failed."),
		);
	}
}
