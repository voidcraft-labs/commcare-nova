"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	previewSearchTargetKey,
	previewSearchTargetSchema,
} from "@/lib/preview/searchSettings";
import { previewSearchChangesSchema } from "@/lib/preview/searchSettingsEdit";
import { setPreviewSearchSettings } from "./previewSearchSettings";

const saveSchema = z.strictObject({
	appId: z.string().min(1).max(255),
	projectId: z.string().min(1).max(255),
	target: previewSearchTargetSchema,
	expectedRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
	changes: previewSearchChangesSchema,
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
	const { appId, projectId, target, expectedRevision, changes } = request.data;
	try {
		const result = await setPreviewSearchSettings(
			{ appId, projectId },
			session.user.id,
			target,
			expectedRevision,
			changes,
		);
		if (result.kind === "changed")
			return {
				kind: result.kind,
				revision: result.catalog.profiles.find(
					(p) =>
						previewSearchTargetKey(p.target) === previewSearchTargetKey(target),
				)?.revision,
			};
		if (result.kind === "invalid") return result;
		return { kind: result.kind };
	} catch (error) {
		if (error instanceof AppAccessError) return denied;
		throw error;
	}
}
