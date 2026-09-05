"use server";

import { z } from "zod";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { uuidSchema } from "@/lib/domain";
import { getLookupFixtureData } from "@/lib/lookup/service";
import {
	readCaseDatabaseSnapshot,
	resolveAuthorizedPreviewContext,
} from "./engine/caseDataBindingHelpers";
import { reportUnexpectedActionError } from "./engine/caseDataBindingTelemetry";
import { previewLookupData } from "./engine/lookupEvaluation";
import { prepareEntryPointLaunch } from "./entryPointLaunch";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
} from "./entryPointLaunchTypes";

const requestSchema = z
	.object({
		appId: z.string().min(1),
		entryPointUuid: uuidSchema,
		personaUuid: uuidSchema.optional(),
		expectedSeq: z.number().int().nonnegative(),
		selections: z
			.array(
				z
					.object({
						moduleUuid: uuidSchema,
						caseIds: z.array(z.string().min(1)).max(1000),
					})
					.strict(),
			)
			.max(100),
	})
	.strict();

export async function launchEntryPointAction(input: {
	appId: string;
	entryPointUuid: string;
	personaUuid?: string;
	expectedSeq: number;
	selections: readonly EntryPointSelection[];
}): Promise<EntryPointLaunchResult> {
	const parsed = requestSchema.safeParse(input);
	if (!parsed.success)
		return {
			kind: "refused",
			message: "Choose an entry point and its required cases, then try again.",
		};
	const args = parsed.data;
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId: args.appId,
			personaUuid: args.personaUuid,
			required: "view",
			loadBlueprint: true,
		});
		if (context.kind !== "ready")
			return {
				kind: "refused",
				message:
					context.kind === "unauthenticated"
						? "Sign in to test this entry point."
						: context.message,
			};
		if (!context.blueprint || context.baseSeq !== args.expectedSeq)
			return {
				kind: "refused",
				message: "The app changed. Wait for it to finish saving and try again.",
			};
		const doc = hydratePersistedBlueprint(context.blueprint);
		const tableIds = extractLookupReferenceTargets(doc).tableIds;
		const [database, lookup] = await Promise.all([
			readCaseDatabaseSnapshot(context.store, {
				appId: args.appId,
				restoreScope: context.restoreScope,
			}),
			tableIds.length
				? getLookupFixtureData(context.scope, tableIds).then(previewLookupData)
				: undefined,
		]);
		const result = prepareEntryPointLaunch({
			...args,
			doc,
			database,
			session: context.identity.session,
			lookup: lookup ? { kind: "data", data: lookup } : { kind: "idle" },
		});
		// Authorization and committed topology must still describe this result after
		// its device/lookup reads. A Project move or concurrent edit retires it.
		const current = await resolveAuthorizedAppSnapshot(
			args.appId,
			context.identity.actorUserId,
			"view",
		);
		if (
			current.baseSeq !== args.expectedSeq ||
			current.projectId !== context.scope.projectId
		)
			return {
				kind: "refused",
				message:
					"The app changed while the entry point was loading. Try again.",
			};
		return result;
	} catch (error) {
		if (error instanceof AppAccessError)
			return { kind: "refused", message: "App not found." };
		reportUnexpectedActionError("launchEntryPoint", error, {
			appId: args.appId,
		});
		return {
			kind: "refused",
			message: "We could not open this entry point. Try again.",
		};
	}
}
