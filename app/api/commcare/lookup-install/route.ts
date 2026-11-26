import { z } from "zod";
import { ApiError, handleApiError, readJsonBody } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug } from "@/lib/commcare/hq/http";
import { isCommCareServer } from "@/lib/commcare/servers";
import { installManualLookupData } from "@/lib/deployment/manualLookupInstall";
import { LookupError } from "@/lib/lookup/errors";
import { manualLookupManifestSchema } from "@/lib/publish/manualLookupManifest";

const schema = z.strictObject({
	manifest: manualLookupManifestSchema,
	server: z.string(),
	domain: z.string().refine(isValidDomainSlug),
	confirm: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
});

export async function POST(req: Request) {
	try {
		const session = await requireSession(req);
		const request = schema.safeParse(await readJsonBody(req, 4096));
		if (!request.success || !isCommCareServer(request.data.server))
			throw new ApiError(
				"Choose a valid install file, server, and project space.",
				400,
			);
		const { manifest, server, domain, confirm } = request.data;
		const result = await installManualLookupData({
			actorUserId: session.user.id,
			grant: { kind: "session", sessionId: session.session.id },
			target: { server, domain },
			manifest,
			confirm,
		});
		return Response.json(result, {
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		if (error instanceof LookupError)
			return handleApiError(
				new ApiError(error.message, error.code === "not_found" ? 404 : 409),
			);
		return handleApiError(
			error instanceof Error ? error : new Error("Lookup installation failed."),
		);
	}
}
