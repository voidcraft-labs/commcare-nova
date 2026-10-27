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
import { readCaseDatabaseSnapshot } from "./engine/caseDataBindingHelpers";
import { reportUnexpectedActionError } from "./engine/caseDataBindingTelemetry";
import { previewLookupData } from "./engine/lookupEvaluation";
import { prepareEntryPointLaunch } from "./entryPointLaunch";
import type {
	EntryPointLaunchResult,
	EntryPointSelection,
} from "./entryPointLaunchTypes";

const requestSchema = z.strictObject({
	appId: z.string().min(1),
	entryPointUuid: uuidSchema,
	personaUuid: uuidSchema.optional(),
	expectedSeq: z.number().int().nonnegative(),
	selections: z
		.array(
			z.strictObject({
				moduleUuid: uuidSchema,
				caseIds: z.array(z.string().min(1)).max(1000),
			}),
		)
		.max(100),
	/** The chosen worker's claims; the context checks their shape. */
	claimedCaseIds: z.array(z.string()).max(1000).optional(),
	/** The device Preview runs on; the context parses and checks it. */
	device: z.unknown().optional(),
});

export async function launchEntryPointAction(input: {
	appId: string;
	entryPointUuid: string;
	personaUuid?: string;
	expectedSeq: number;
	selections: readonly EntryPointSelection[];
	/** The chosen worker's claims (`lib/session/previewClaims.ts`): a
	 *  claimed case is held, so the launch's device snapshot holds it. */
	claimedCaseIds?: readonly string[];
	/** The device Preview runs on (`previewDevice.ts`), plain JSON. */
	device?: PreviewDevice;
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
			claimedCaseIds: args.claimedCaseIds,
			required: "view",
			loadBlueprint: true,
			device: args.device,
		});
		if (context.kind !== "ready")
			return {
				kind: "refused",
				message:
					context.kind === "unauthenticated"
						? "Sign in to test this entry point."
						: context.message,
			};
		const rules = previewPlatformRules(context.device.platform);
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
		/* A chosen case the worker's restore does not hold, read with its
		 * index edges as a claim of it would deliver it. The claim seeds only
		 * a case of this app in the bound Project, so nothing else is read. */
		const held = new Set(database.rows.map((row) => row.case_id));
		const outside = [
			...new Set(
				args.selections.flatMap((selection) =>
					selection.caseIds.filter((caseId) => !held.has(caseId)),
				),
			),
		];
		const notHeld = await readNotHeldCases(context, args.appId, outside);
		const result = prepareEntryPointLaunch({
			...args,
			doc,
			database,
			notHeld: {
				rows: notHeld.rows.filter((row) => !held.has(row.case_id)),
				indices: notHeld.indices.filter((index) => !held.has(index.case_id)),
			},
			session: previewSessionValues(context.identity, context.device),
			lookup: lookup ? { kind: "data", data: lookup } : { kind: "idle" },
			rules,
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

/** The chosen cases outside the worker's restore, with their index edges, as
 * a claim of each would put them on the device. */
async function readNotHeldCases(
	context: Extract<AuthorizedPreviewContext, { kind: "ready" }>,
	appId: string,
	caseIds: readonly string[],
): Promise<CaseDatabaseSnapshot> {
	if (caseIds.length === 0) return { rows: [], indices: [] };
	const wanted = new Set(caseIds);
	const claimed = await readCaseDatabaseSnapshot(context.store, {
		appId,
		restoreScope: {
			...context.restoreScope,
			claimedCaseIds: [
				...(context.restoreScope.claimedCaseIds ?? []),
				...caseIds,
			],
		},
	});
	return {
		rows: claimed.rows.filter((row) => wanted.has(row.case_id)),
		indices: claimed.indices.filter((index) => wanted.has(index.case_id)),
	};
}

/**
 * The Project's open cases of a case type that the worker's restore does not
 * hold, 50 a page: HQ's search population less the worker's restore closure,
 * paged and counted in one statement each. An entry point's case picker
 * offers them under the worker's own cases, so an author can see what each
 * platform does with a case the worker's phone lacks.
 */
export async function loadEntryPointOtherCasesAction(input: {
	appId: string;
	caseType: string;
	personaUuid?: string;
	claimedCaseIds?: readonly string[];
	parentCase?: ParentCaseSelection;
	page: { offset: number; limit: number };
	device?: PreviewDevice;
}): Promise<LoadCasesResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId: input.appId,
			personaUuid: input.personaUuid,
			claimedCaseIds: input.claimedCaseIds,
			required: "view",
			loadBlueprint: true,
			device: input.device,
		});
		if (context.kind !== "ready") return context;
		return await readCases(context.store, {
			appId: input.appId,
			caseType: input.caseType,
			reading: SEARCH_READING,
			tileGrouping: "flat",
			parentCase: input.parentCase,
			page: input.page,
			searchPopulation: {
				heldBy: context.restoreScope,
				onlyOutsideRestore: true,
			},
		});
	} catch (error) {
		if (error instanceof AppAccessError)
			return { kind: "error", message: "App not found." };
		reportUnexpectedActionError("loadEntryPointOtherCases", error, {
			appId: input.appId,
		});
		return {
			kind: "error",
			message: "We couldn't load these cases. Try again.",
		};
	}
}

import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { readCases } from "./engine/caseDataBindingHelpers";
import type {
	LoadCasesResult,
	ParentCaseSelection,
} from "./engine/caseDataBindingTypes";
import { previewSessionValues } from "./engine/identity";
import {
	type AuthorizedPreviewContext,
	resolveAuthorizedPreviewContext,
} from "./engine/previewAuthorization";
import type { PreviewDevice } from "./engine/previewDevice";
import type { CaseDatabaseSnapshot } from "./engine/xpathInstances";
import { previewPlatformRules } from "./platform";
