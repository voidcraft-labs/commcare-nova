"use server";

import { z } from "zod";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	type BlueprintDoc,
	caseSelectionMaximum,
	type Uuid,
} from "@/lib/domain";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { entrySelectionSettings } from "@/lib/domain/formEntryCases";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { uuidSchema } from "@/lib/domain/uuid";
import { getLookupDefinitions } from "@/lib/lookup/service";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { parentCaseConstraint } from "../caseSelectionNavigation";
import { workerListDocument } from "../workerModule";
import { loadCasesAction } from "./caseDataBinding";
import { readCaseDatabaseSnapshot } from "./caseDataBindingHelpers";
import type { ParentCaseSelection } from "./caseDataBindingTypes";
import { overlayCaseDatabasePatch } from "./caseDatabasePatch";
import { previewDataRefusalOf } from "./dataRefusal";
import {
	caseListStepSession,
	entrySessionData,
	entryWalksChoices,
} from "./entrySessionData";
import { appReadsPlaces } from "./expressionCaseReads";
import {
	type FormOpeningAudience,
	type FormOpeningProjection,
	openingCaseData,
	restoreOpeningCases,
	restoreOpeningLookup,
	type SignedFormOpening,
	signedOpeningSchema,
} from "./formOpeningSnapshot";
import { previewSessionValues } from "./identity";
import { loadLookupFixtureDataAction } from "./lookupDataBinding";
import {
	caseOperationProgramLookupTableIds,
	collectConfigLookupTableIds,
} from "./lookupTableReferences";
import { resolveAuthorizedPreviewContext } from "./previewAuthorization";
import type { PreviewDevice } from "./previewDevice";
import { signFormOpening, verifyFormOpening } from "./signedFormOpening";
import {
	evaluateWebFormActivityOpening,
	InvalidWebActivityWindowError,
	recordWebActivityOpening,
} from "./webFormActivityOpening";
import { workerLocationFixture, workerPlaceIds } from "./workerLocationFixture";

const manualChoiceSchema = z.strictObject({
	selection: uuidSchema,
	caseId: z.string().min(1),
});

const requestSchema = z.strictObject({
	app: z.string().min(1),
	module: uuidSchema,
	form: uuidSchema,
	run: z.uuid(),
	entry: z.uuid(),
	blueprintDigest: z.string().regex(/^[0-9a-f]{64}$/),
	persona: uuidSchema.optional(),
	bound: z.array(z.string().min(1)).optional(),
	parentChoices: z.record(uuidSchema, z.array(z.string().min(1))).optional(),
	previous: signedOpeningSchema.optional(),
	restore: z.literal(true).optional(),
	choice: manualChoiceSchema.optional(),
	carried: z.array(manualChoiceSchema).optional(),
	/** The form entries the device submitted since it last synced, oldest
	 * first: it holds each one's committed patch. */
	afterSubmission: z.array(z.string().min(1)).max(32).optional(),
});

function tablesForOpening(doc: BlueprintDoc, form: Uuid) {
	const record = doc.forms[form];
	const carriers = [
		form,
		...(formStructure(doc, form)?.fields.keys() ?? []),
		...(record.caseOperations ?? []).map((op) => op.uuid),
		...(record.caseSelections ?? []).map((row) => row.uuid),
		...(record.computedDatums ?? []).map((row) => row.uuid),
	];
	const tables = new Set(caseOperationProgramLookupTableIds(doc, carriers));
	for (const { source } of formCaseSelections(doc, form)) {
		if (source.kind === "table") tables.add(source.table);
		if (source.kind === "choose")
			for (const id of collectConfigLookupTableIds(
				doc.modules[source.module]?.caseListConfig,
			))
				tables.add(id);
	}
	return [...tables];
}

export async function readFormOpeningAction(
	input: z.input<typeof requestSchema>,
	device: PreviewDevice,
) {
	const parsed = requestSchema.safeParse(input);
	const reopen = {
		kind: "reopen",
		message: "The opening records changed. Open the form again to load them.",
	} as const;
	/* The record the form opens on is no longer one the worker's device
	 * holds: the worker can choose another on its list. */
	const unavailable = { kind: "record-unavailable" } as const;
	if (!parsed.success) return reopen;
	const args = parsed.data;
	try {
		const context = await resolveAuthorizedPreviewContext({
			appId: args.app,
			personaUuid: args.persona,
			required: "view",
			device,
			loadBlueprint: true,
		});
		if (context.kind !== "ready") return context;
		if (
			!context.sessionId ||
			!context.blueprint ||
			context.baseSeq === undefined
		)
			return reopen;
		const doc = hydratePersistedBlueprint(context.blueprint);
		if (
			moduleUuidOfForm(doc, args.form) !== args.module ||
			canonicalJsonDigest(toPersistableDoc(doc)) !== args.blueprintDigest
		)
			return reopen;
		const audience: FormOpeningAudience = {
			app: args.app,
			project: context.scope.projectId,
			actor: context.identity.actorUserId,
			session: context.sessionId,
			worker: context.identity.ownerId,
			persona: context.identity.personaUuid ?? null,
			device: context.device,
			run: args.run,
			module: args.module,
			form: args.form,
			entry: args.entry,
			revision: context.baseSeq,
			blueprintDigest: args.blueprintDigest,
		};
		const secret = process.env.BETTER_AUTH_SECRET ?? "";
		let prior: FormOpeningProjection;
		/* The cases the submission that opened this entry left on the device,
		 * which its list no longer need show (a case it closed). */
		let submittedCaseIds = new Set<string>();
		if (args.previous) {
			prior = await verifyFormOpening(secret, audience, args.previous);
			if (
				args.bound ||
				args.parentChoices ||
				args.carried ||
				(args.restore ? args.choice : prior.complete || !args.choice)
			)
				return reopen;
			submittedCaseIds = new Set(prior.submittedCaseIds ?? []);
			if (
				!(await context.store.holdsDeviceCases({
					appId: args.app,
					restoreScope: context.restoreScope,
					caseIds: prior.cases.rows
						.map((row) => row.case_id)
						.filter((id) => !submittedCaseIds.has(id)),
				}))
			)
				return prior.primaryCaseIds.length ? unavailable : reopen;
			if (prior.cases.locations?.length) {
				const currentPlaces = new Set(
					await workerPlaceIds(args.app, context.blueprint, args.persona),
				);
				if (prior.cases.locations.some((place) => !currentPlaces.has(place.id)))
					return reopen;
			}
			if (prior.lookup.definitions.length) {
				const currentTables = await getLookupDefinitions(
					context.scope,
					prior.lookup.definitions.map((table) => table.id),
				);
				const present = new Set(
					currentTables.definitions.map((table) => table.id),
				);
				if (prior.lookup.definitions.some((table) => !present.has(table.id)))
					return reopen;
			}
		} else {
			if (args.choice || args.restore) return reopen;
			const tableIds = tablesForOpening(doc, args.form);
			const lookup = await loadLookupFixtureDataAction(args.app, tableIds);
			if (lookup.kind !== "data") return lookup;
			if (
				tableIds.some(
					(id) => !lookup.data.definitions.some((table) => table.id === id),
				)
			)
				return reopen;
			const restore = await readCaseDatabaseSnapshot(context.store, {
				appId: args.app,
				restoreScope: context.restoreScope,
			});
			/* A device keeps what it submitted until it syncs, a case a
			 * submission closed among it, so the form reads the restore with
			 * each of those submissions' committed patches, read from this
			 * actor's own receipts, laid over it in order. */
			let restored = restore;
			for (const entryKey of args.afterSubmission ?? []) {
				const submitted = await context.store.readSubmittedCaseDatabasePatch({
					appId: args.app,
					entryKey,
				});
				if (submitted === undefined) return reopen;
				restored = overlayCaseDatabasePatch(restored, submitted);
				for (const row of submitted.rows) submittedCaseIds.add(row.case_id);
			}
			const cases = appReadsPlaces(doc)
				? {
						...restored,
						locations: await workerLocationFixture(
							args.app,
							context.blueprint,
							args.persona,
						),
					}
				: restored;
			prior = {
				cases: openingCaseData(cases),
				lookup: lookup.data,
				choices: [],
				primaryCaseIds: [],
				datums: {},
				resolvedEntries: {},
				sessionData: {},
				complete: false,
			};
		}
		const snapshot = restoreOpeningCases(prior.cases);
		const rows = new Map(snapshot.rows.map((row) => [row.case_id, row]));
		const lookupData = restoreOpeningLookup(prior.lookup);
		const session = previewSessionValues(context.identity, context.device);
		const menuSelections: Record<string, PreviewMenuCaseSelection> = {};
		async function available(
			module: Uuid,
			ids: readonly string[],
			parentCase?: ParentCaseSelection,
			explicit = false,
			chosenCaseIds?: Readonly<Record<string, string>>,
		) {
			if (ids.length === 0) return true;
			if (new Set(ids).size !== ids.length || ids.some((id) => !rows.has(id)))
				return false;
			if (ids.every((id) => submittedCaseIds.has(id))) return true;
			const listed = explicit
				? workerListDocument(doc, module, "form-selection")
				: doc;
			const list = listed.modules[module];
			if (
				!list?.caseType ||
				ids.length > (explicit ? 1 : caseSelectionMaximum(list))
			)
				return false;
			const result = await loadCasesAction({
				appId: args.app,
				caseType: list.caseType,
				moduleUuid: module,
				caseIds: ids,
				blueprint: listed,
				caseListConfig: list.caseListConfig,
				excludedOwnerIdsExpression: list.caseSearchConfig?.excludedOwnerIds,
				chosenCaseIds:
					chosenCaseIds ??
					caseListStepSession(doc, module, {
						menuSelections,
						caseDatabase: snapshot,
						session,
					}).chosenCaseIds,
				device,
				personaUuid: args.persona,
				parentCase,
			});
			return result.kind === "rows" && result.rows.length === ids.length;
		}
		const owner = doc.forms[args.form];
		const bound = args.bound ?? prior.primaryCaseIds;
		const parentChoices: Readonly<Record<string, readonly string[]>> =
			args.parentChoices ?? prior.parentChoices ?? {};
		const chain: Uuid[] = [];
		const seen = new Set<Uuid>([args.module]);
		let parent = doc.modules[args.module]?.parentCaseModuleUuid;
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			chain.unshift(parent);
			parent = doc.modules[parent]?.parentCaseModuleUuid;
		}
		for (const menu of chain) {
			const ids = parentChoices[menu];
			if (!ids?.length) continue;
			const type = doc.modules[menu].caseType;
			const ancestor = doc.modules[menu].parentCaseModuleUuid;
			const under = ancestor
				? parentCaseConstraint(doc, menu, menuSelections[ancestor])
				: undefined;
			if (!type || (!args.previous && !(await available(menu, ids, under))))
				return reopen;
			menuSelections[menu] = {
				caseType: type,
				cases: ids.map((caseId) => ({
					caseId,
					caseName: rows.get(caseId)?.case_name ?? "",
				})),
			};
		}
		if (
			Object.keys(parentChoices).some(
				(menu) => !Object.hasOwn(menuSelections, menu),
			)
		)
			return reopen;
		if (!args.previous && owner.caseSelections === undefined) {
			const isCaseForm = owner.type === "followup" || owner.type === "close";
			const parent = doc.modules[args.module].parentCaseModuleUuid;
			const under = parent
				? parentCaseConstraint(doc, args.module, menuSelections[parent])
				: undefined;
			// A form whose datum opens its single match automatically walks its
			// menu's choices here instead; each one is checked as it is reached.
			const walks = bound.length === 0 && entryWalksChoices(doc, args.form);
			if (
				(!walks && isCaseForm !== bound.length > 0) ||
				(isCaseForm && parent && !under)
			)
				return reopen;
			if (!(await available(args.module, bound, under))) return unavailable;
		} else if (args.bound) return reopen;
		const resolve = (choices: FormOpeningProjection["choices"]) =>
			entrySessionData(doc, args.form, {
				appId: args.app,
				entryKey: args.entry,
				caseDatabase: snapshot,
				session,
				lookupData,
				boundCases: bound.map((caseId) => ({
					caseId,
					caseName: rows.get(caseId)?.case_name ?? "",
				})),
				menuSelections,
				heldEntryValues: prior.resolvedEntries,
				entryChoices: choices.map((choice) => ({
					selectionUuid: choice.selection,
					caseId: choice.caseId,
					caseName: rows.get(choice.caseId)?.case_name ?? "",
				})),
			});
		let choices = prior.choices;
		let reached = resolve(choices);
		const carried = new Map(
			(args.carried ?? prior.carried ?? []).map((choice) => [
				choice.selection,
				choice,
			]),
		);
		if (args.carried) {
			const manual = new Set(
				formCaseSelections(doc, args.form)
					.filter((row) => row.source.kind === "choose")
					.map((row) => row.uuid),
			);
			if (
				args.carried.length !== carried.size ||
				args.carried.some((choice) => !manual.has(choice.selection))
			)
				return reopen;
		}
		let manual = args.choice;
		while (
			manual ||
			(reached.nextSelection &&
				carried.has(reached.nextSelection.selectionUuid))
		) {
			const next = reached.nextSelection;
			const choice = manual ?? (next && carried.get(next.selectionUuid));
			if (!next || !choice || choice.selection !== next.selectionUuid)
				return reopen;
			const under = next.under && {
				caseType: next.under.caseType,
				caseIds: [next.under.caseId],
				index: next.under.identifier,
			};
			if (
				!(await available(
					next.moduleUuid,
					[choice.caseId],
					under,
					true,
					next.chosenCaseIds,
				))
			)
				return reopen;
			choices = [...choices, choice];
			carried.delete(choice.selection);
			manual = undefined;
			prior = {
				...prior,
				resolvedEntries: reached.resolvedEntryValues ?? prior.resolvedEntries,
			};
			reached = resolve(choices);
		}
		const ownIndex = ownFormSelectionIndex(doc, args.form);
		const own =
			ownIndex === undefined
				? undefined
				: formCaseSelections(doc, args.form)[ownIndex];
		const ownCaseId = own && reached.reachedCaseIds.get(own.uuid);
		// A walked case form is complete only once its own case is reached.
		const caseForm = owner.type === "followup" || owner.type === "close";
		if (
			!reached.nextSelection &&
			caseForm &&
			entrySelectionSettings(owner) === undefined &&
			!ownCaseId &&
			bound.length === 0
		)
			return reopen;
		const primaryCaseIds = ownCaseId ? [ownCaseId] : bound;
		const activity =
			!reached.nextSelection && !args.restore
				? await evaluateWebFormActivityOpening({
						secret,
						doc,
						audience,
						identity: context.identity,
						reached,
						caseIds: primaryCaseIds,
						cases: snapshot,
						lookup: lookupData,
					})
				: undefined;
		const projection: FormOpeningProjection = {
			...prior,
			choices,
			carried: [...carried.values()],
			...(Object.keys(parentChoices).length && { parentChoices }),
			primaryCaseIds,
			...(activity && { webActivity: activity }),
			...(submittedCaseIds.size > 0 && {
				submittedCaseIds: [...submittedCaseIds],
			}),
			// The session keeps its records without a prototype; a Server
			// Action answers only with plain objects, so each is copied into one.
			sessionData: { ...reached.data },
			datums: { ...reached.datumsByRef },
			resolvedEntries: { ...reached.resolvedEntryValues },
			complete: !reached.nextSelection,
		};
		const next = reached.nextSelection && {
			...reached.nextSelection,
			chosenCaseIds: { ...reached.nextSelection.chosenCaseIds },
		};
		const evidence: SignedFormOpening = await signFormOpening(
			secret,
			audience,
			projection,
			args.previous,
		);
		const activityNotice = activity
			? await recordWebActivityOpening(audience, activity, snapshot)
			: undefined;
		return {
			kind: "opening",
			evidence,
			projection,
			next,
			activityNotice,
		} as const;
	} catch (error) {
		if (error instanceof InvalidWebActivityWindowError)
			return { kind: "error", message: error.message } as const;
		if (error instanceof AppAccessError)
			return { kind: "error", message: "App not found." } as const;
		const refusal = previewDataRefusalOf(error);
		if (refusal)
			return { kind: "data-refused", reason: refusal.reason } as const;
		if (
			error instanceof Error &&
			error.name === "CaptureSubmissionRejectedError"
		)
			return reopen;
		throw error;
	}
}
