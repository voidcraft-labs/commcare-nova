"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	previewSearchTargetSchema,
	previewSearchValuesSchema,
} from "@/lib/preview/searchSettings";
import { setPreviewSearchSettings } from "./previewSearchSettings";

const saveSchema = z.strictObject({
	appId: z.string().min(1).max(255),
	projectId: z.string().min(1).max(255),
	target: previewSearchTargetSchema,
	expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
	values: previewSearchValuesSchema,
});

export async function savePreviewSearchSettingsAction(input: unknown) {
	const request = saveSchema.safeParse(input);
	if (!request.success)
		return {
			kind: "invalid" as const,
			message:
				request.error.issues[0]?.message ?? "Review the search settings.",
		};
	const session = await getSession();
	const denied = {
		kind: "unavailable" as const,
		message: "These settings need edit access to this Project.",
	};
	if (!session) return denied;
	const { appId, projectId, target, expectedRevision, values } = request.data;
	try {
		return await setPreviewSearchSettings(
			{ appId, projectId },
			session.user.id,
			target,
			expectedRevision,
			values,
		);
	} catch (error) {
		if (error instanceof AppAccessError) return denied;
		throw error;
	}
}
