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
import {
	entrySelectionSettings,
	formContentUuid,
} from "@/lib/domain/formEntryCases";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { uuidSchema } from "@/lib/domain/uuid";
import { getLookupDefinitions } from "@/lib/lookup/service";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { parentCaseConstraint } from "../caseSelectionNavigation";
import { previewPlatformRules } from "../platform";
import { workerListDocument } from "../workerModule";
import { boundedFlatCloseForm } from "./boundedFlatClose";
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
import { FormEvaluationInputError } from "./formEvaluationTypes";
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
import { formLogicLookupExpressions } from "./lookupEvaluation";
import {
	caseOperationProgramLookupTableIds,
	collectConfigLookupTableIds,
} from "./lookupTableReferences";
import { resolveAuthorizedPreviewContext } from "./previewAuthorization";
import type { PreviewDevice } from "./previewDevice";
import {
	openingCarryScope,
	signFormOpening,
	signReceiptRunTransition,
	verifyFormOpening,
} from "./signedFormOpening";
import {
	evaluateFormOpeningActions,
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
	boundedFlatClose: z.literal(true).optional(),
	parentChoices: z.record(uuidSchema, z.array(z.string().min(1))).optional(),
	previous: signedOpeningSchema.optional(),
	restore: z.literal(true).optional(),
	resumeInto: z.uuid().optional(),
	choice: manualChoiceSchema.optional(),
	carried: z.array(manualChoiceSchema).optional(),
	/** The form entries the device submitted since it last synced, oldest
	 * first: it holds each one's committed patch. */
	afterSubmission: z.array(z.string().min(1)).max(32).optional(),
});

function validSelectionIds(ids: readonly string[], maximum: number): boolean {
	return ids.length <= maximum && new Set(ids).size === ids.length;
}

function tablesForOpening(doc: BlueprintDoc, form: Uuid) {
	const contentUuid = formContentUuid(doc, form);
	const content = doc.forms[contentUuid];
	// The questions and writes run from the source form. Keep entry
	// expressions scoped to the active route since shared choices reuse IDs.
	const carriers = [
		form,
		...(formStructure(doc, contentUuid)?.fields.keys() ?? []),
		...(content.caseOperations ?? []).map((op) => op.uuid),
	];
	const tables = new Set([
		...caseOperationProgramLookupTableIds(doc, carriers),
		...collectConfigLookupTableIds(
			undefined,
			formLogicLookupExpressions(doc, form),
		),
	]);
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
	input: Omit<z.input<typeof requestSchema>, "resumeInto">,
	device: PreviewDevice,
) {
	const result = await readOpening(input, device);
	if (result.kind === "receipt-run-ready")
		return {
			kind: "reopen",
			message: "Open the form again to load its records.",
		} as const;
	return result;
}

export async function authorizeSavedFormReceiptRun(
	input: z.input<typeof requestSchema> & { resumeInto: string; restore: true },
	device: PreviewDevice,
) {
	// The return value deliberately carries no opening snapshot.
	const result = await readOpening(input, device);
	return result.kind === "receipt-run-ready" ? result.transition : undefined;
}

async function readOpening(
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
		const platformRules = previewPlatformRules(context.device.platform);
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
		const previous =
			args.previous &&
			(await verifyFormOpening(secret, audience, args.previous));
		if (args.boundedFlatClose || previous?.boundedFlatClose) {
			const profile = boundedFlatCloseForm(doc, args.module, args.form);
			if (
				!profile ||
				context.device.platform !== "web-apps" ||
				args.choice ||
				args.carried?.length ||
				Object.keys(args.parentChoices ?? {}).length ||
				args.afterSubmission?.length ||
				(previous &&
					(!previous.boundedFlatClose || !args.restore || args.bound)) ||
				(!previous && (args.restore || args.resumeInto))
			)
				return reopen;
			if (previous?.boundedFlatClose && args.resumeInto) {
				if (!previous.complete || !platformRules.resumeDraftAcrossRuns)
					return reopen;
				return {
					kind: "receipt-run-ready",
					transition: signReceiptRunTransition(secret, audience, {
						from: args.run,
						to: args.resumeInto,
						entry: args.entry,
					}),
				} as const;
			}
			const caseIds = previous?.primaryCaseIds ?? args.bound ?? [];
			const expiresAt =
				previous?.boundedFlatClose?.expiresAt ??
				Date.now() + 24 * 60 * 60 * 1000;
			if (
				!caseIds.length ||
				!validSelectionIds(caseIds, profile.selection.maximum) ||
				expiresAt <= Date.now()
			)
				return unavailable;
			const cases = await context.store.readFlatCloseSelection({
				appId: args.app,
				caseIds,
				caseType: profile.caseType,
				restoreScope: context.restoreScope,
				...(profile.selection.autoSelect && {
					automaticMaximum: profile.selection.maximum,
				}),
			});
			if (!cases) return unavailable;
			const projection: FormOpeningProjection = previous ?? {
				cases: openingCaseData(cases),
				lookup: { projectRevision: "0", definitions: [], rowsByTable: {} },
				choices: [],
				primaryCaseIds: caseIds,
				datums: {},
				resolvedEntries: {},
				sessionData: {},
				complete: true,
				boundedFlatClose: { expiresAt },
			};
			return {
				kind: "opening",
				projection,
				evidence:
					args.previous ??
					(await signFormOpening(secret, audience, projection)),
				next: undefined,
				activityNotice: undefined,
			} as const;
		}
		let prior: FormOpeningProjection;
		/* The cases the submission that opened this entry left on the device,
		 * which its list no longer need show (a case it closed). */
		let submittedCaseIds = new Set<string>();
		if (previous) {
			prior = previous;
			if (
				args.bound ||
				args.parentChoices ||
				args.carried ||
				(args.restore ? args.choice : prior.complete || !args.choice)
			)
				return reopen;
			if (args.resumeInto) {
				if (
					!args.restore ||
					!prior.complete ||
					!platformRules.resumeDraftAcrossRuns
				)
					return reopen;
				return {
					kind: "receipt-run-ready",
					transition: signReceiptRunTransition(secret, audience, {
						from: args.run,
						to: args.resumeInto,
						entry: args.entry,
					}),
				} as const;
			}
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
			if (args.choice || args.restore || args.resumeInto) return reopen;
			// Reject an oversized or duplicate selection before reading tables or
			// building the worker's full device snapshot. The ordinary availability
			// checks below still prove scope, list membership, and linked parents.
			const owner = doc.forms[args.form];
			const isCaseForm = owner.type === "followup" || owner.type === "close";
			if (
				owner.caseSelections === undefined &&
				isCaseForm &&
				args.bound &&
				!validSelectionIds(
					args.bound,
					caseSelectionMaximum(doc.modules[args.module]),
				)
			)
				return unavailable;
			for (const [menu, ids] of Object.entries(args.parentChoices ?? {})) {
				const list = doc.modules[menu as Uuid];
				if (!list || !validSelectionIds(ids, caseSelectionMaximum(list)))
					return reopen;
			}
			const tableIds = tablesForOpening(doc, args.form);
			const lookup = await loadLookupFixtureDataAction(
				args.app,
				tableIds,
				context.identity.personaUuid,
			);
			if (lookup.kind !== "data") return lookup;
			if (
				tableIds.some(
					(id) => !lookup.data.definitions.some((table) => table.id === id),
				)
			)
				return reopen;
			const webActivityRestoreStartedAt =
				platformRules.recentFormActivity &&
				doc.forms[formContentUuid(doc, args.form)]?.activityKeyText
					? Date.now()
					: undefined;
			const restore = await readCaseDatabaseSnapshot(context.store, {
				appId: args.app,
				restoreScope: context.restoreScope,
			});
			/* A device keeps what it submitted until it syncs, a case a
			 * submission closed among it, so the form reads the restore with
			 * each of those submissions' committed patches, read from this
			 * actor's own receipts, laid over it in order. */
			let restored = restore;
			const carryScope = openingCarryScope(audience);
			for (const entryKey of args.afterSubmission ?? []) {
				const submitted = await context.store.readSubmittedCaseDatabasePatch({
					appId: args.app,
					entryKey,
					openingCarryScope: carryScope,
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
				...(webActivityRestoreStartedAt !== undefined && {
					webActivityRestoreStartedAt,
				}),
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
			boundAfterSubmit = false,
		) {
			if (ids.length === 0) return true;
			const listed = explicit
				? workerListDocument(doc, module, "form-selection")
				: doc;
			const list = listed.modules[module];
			if (
				!list?.caseType ||
				!validSelectionIds(ids, explicit ? 1 : caseSelectionMaximum(list)) ||
				ids.some((id) => rows.get(id)?.case_type !== list.caseType)
			)
				return false;
			const carried = boundAfterSubmit
				? ids.filter((id) => submittedCaseIds.has(id))
				: [];
			if (
				carried.length &&
				parentCase &&
				(parentCase.caseIds.some(
					(id) => rows.get(id)?.case_type !== parentCase.caseType,
				) ||
					carried.some(
						(id) =>
							!snapshot.indices.some(
								(edge) =>
									edge.case_id === id &&
									edge.depth === 1 &&
									parentCase.caseIds.includes(edge.ancestor_id) &&
									(parentCase.index === undefined
										? edge.relationship !== "extension"
										: edge.identifier === parentCase.index),
							),
					))
			)
				return false;
			const toChoose = ids.filter((id) => !carried.includes(id));
			if (toChoose.length === 0) return true;
			const result = await loadCasesAction({
				appId: args.app,
				caseType: list.caseType,
				moduleUuid: module,
				caseIds: toChoose,
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
			return result.kind === "rows" && result.rows.length === toChoose.length;
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
			if (!(await available(args.module, bound, under, false, undefined, true)))
				return unavailable;
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
					manual === undefined,
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
		const actions =
			!reached.nextSelection && !args.restore
				? await evaluateFormOpeningActions({
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
		const activity = actions?.activity;
		const projection: FormOpeningProjection = {
			...prior,
			choices,
			carried: [...carried.values()],
			...(Object.keys(parentChoices).length && { parentChoices }),
			primaryCaseIds,
			...(activity && { webActivity: activity }),
			...(actions?.caseCreateIds && { caseCreateIds: actions.caseCreateIds }),
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
			? await recordWebActivityOpening(
					audience,
					activity,
					snapshot,
					prior.webActivityRestoreStartedAt ?? Date.now(),
				)
			: undefined;
		return {
			kind: "opening",
			evidence,
			projection,
			next,
			activityNotice,
		} as const;
	} catch (error) {
		if (
			error instanceof InvalidWebActivityWindowError ||
			error instanceof FormEvaluationInputError
		)
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
