"use server";

import { z } from "zod";
import { CaseNotFoundError } from "@/lib/case-store";
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
	/** The device Preview runs on; the context parses and checks it. */
	device: z.unknown().optional(),
});

export async function launchEntryPointAction(input: {
	appId: string;
	entryPointUuid: string;
	personaUuid?: string;
	expectedSeq: number;
	selections: readonly EntryPointSelection[];
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
		 * direct index edges as a claim of it would deliver it: the exact rows
		 * of this app in the bound Project, so nothing else is read. */
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
		/* Web Apps' claim frame posts the launch's claims before it navigates
		 * (`endpoints.py::EndpointsHelper._add_claim_frame`): claim rows for
		 * the worker, written after the last authorization check so a launch
		 * this action refuses claims nothing. Android never reaches the claim,
		 * so `claimCaseIds` is empty there. */
		if (
			result.kind === "ready" &&
			rules.entryPointClaims === "posted" &&
			result.claimCaseIds.length > 0
		)
			await context.store.claimCases({
				appId: args.appId,
				caseIds: result.claimCaseIds,
			});
		return result;
	} catch (error) {
		if (error instanceof AppAccessError)
			return {
				kind: "refused",
				message:
					error.reason === "insufficient_role"
						? "In Web Apps this entry point claims the chosen cases for the worker, which writes to the app's case data, and a viewer of this Project can't write there. A Project admin can give you edit access, or you can try it running as Android."
						: "App not found.",
			};
		if (error instanceof CaseNotFoundError)
			return {
				kind: "refused",
				message:
					"One of the chosen cases was removed from the app's case data, so it can't be opened. Choose the cases again.",
			};
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
	const patch = await context.store.readCaseDatabasePatch({ appId, caseIds });
	return {
		rows: patch.rows.filter((row) => wanted.has(row.case_id)),
		indices: patch.indices.filter((index) => wanted.has(index.case_id)),
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
	parentCase?: ParentCaseSelection;
	page: { offset: number; limit: number };
	device?: PreviewDevice;
}): Promise<LoadCasesResult> {
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId: input.appId,
			personaUuid: input.personaUuid,
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
