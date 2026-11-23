"use server";

import type { Uuid } from "@/lib/domain";
import { LookupError } from "@/lib/lookup/errors";
import { resolveAuthorizedPreviewContext } from "./previewAuthorization";
import type { PreviewDevice } from "./previewDevice";
import { openSavedSearchRanges } from "./savedSearchRanges";
import { serverPreviewDataRefusalOf } from "./serverDataRefusal";

/** Resolve worker-dependent starting dates exactly once as the query opens. */
export async function openSearchRangesAction(args: {
	appId: string;
	moduleUuid: Uuid;
	personaUuid?: string;
	viewerTimeZone: string;
	device: PreviewDevice;
}) {
	const context = await resolveAuthorizedPreviewContext({
		appId: args.appId,
		personaUuid: args.personaUuid,
		device: args.device,
		required: "view",
		loadBlueprint: true,
	});
	if (context.kind !== "ready") return { kind: "unavailable" } as const;
	try {
		return {
			kind: "opened",
			fields: await openSavedSearchRanges(args, context),
		} as const;
	} catch (error) {
		if (error instanceof LookupError && error.code === "storage_limit")
			return { kind: "unavailable", message: error.message } as const;
		const refusal = serverPreviewDataRefusalOf(error);
		if (refusal) return { kind: "refused", reason: refusal.reason } as const;
		throw error;
	}
}
