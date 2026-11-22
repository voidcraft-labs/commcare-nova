import { uuidSchema as workerUuidSchema } from "@/lib/domain/uuid";
import { readPreviewLookup } from "@/lib/preview/engine/workerLookupScope";
import { lookupAgentScope } from "../tools/shared/lookupScope";
import "server-only";
import { getAuthDb } from "@/lib/auth/db";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	buildCaseTypeMap,
	type CaseStore,
	type RestoreScope,
	withProjectContext,
} from "@/lib/case-store";
import { resolveAppScope } from "@/lib/db/appAccess";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	moduleFormsReadSearch,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import {
	type LanguageTag,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import { declaredPlatforms, type Platform } from "@/lib/domain/platforms";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import { previewDataRefusalSubject } from "@/lib/preview/engine/dataRefusal";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import {
	type EvaluationScenario,
	evaluationScenarioCases,
} from "@/lib/preview/engine/evaluationScenario";
import {appReadsWorkerGroups,appReadsPlaces } from "@/lib/preview/engine/expressionCaseReads";
import type { FormEvaluationContext } from "@/lib/preview/engine/formEvaluationTypes";
import {
	previewAsMe,
	previewAsPersona,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { previewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import {
	previewAppLanguage,
	serverPreviewDevice,
} from "@/lib/preview/engine/previewDevice";
import { readWorkerLookupProjection } from "@/lib/deployment/workerLookupProjection";
import { openSearchRunState } from "@/lib/preview/engine/searchRunState";
import { serverPreviewDataRefusalOf } from "@/lib/preview/engine/serverDataRefusal";
import {
	serverRecordsRead,
	serverSearchResults,
} from "@/lib/preview/engine/serverSearchRead";
import { SurfacedDataRefusal } from "@/lib/preview/engine/surfacedDataRefusal";
import { workerLocationFixture } from "@/lib/preview/engine/workerLocationFixture";
import {
	type CaseDatabaseSnapshot,
	formReadsSearchResults,
	type SearchResultsSnapshot,
} from "@/lib/preview/engine/xpathInstances";
import {
	effectivePreviewPlatform,
	platformUnavailableSentence,
} from "@/lib/preview/platform";
import { dataRefusalCopy } from "@/lib/preview/runtimeMessages";
import type { ToolInvocationContext } from "../workspace/types";

/** The form a check runs, which decides whether it needs a search's results. */
interface EvaluatedForm {
	readonly formUuid: Uuid;
	readonly language?: LanguageTag;
	/** Values from the preceding Search; absent presses Search with defaults. */
	readonly searchAnswers?: readonly { name: string; value: string }[];
}

/** Capture real, authorized data without Preview's usercase or schema writes.
 * An unpublished workspace has no case rows or places; Project lookup data is
 * still real. The worker's places come with their cases, and a form that reads
 * what its module's search found gets that search, run over the Project's
 * records as Preview runs it. */
export async function loadFormEvaluationContext(
	ctx: ToolInvocationContext,
	personaUuid?: string,
	scenario?: EvaluationScenario,
	form?: EvaluatedForm,
	/** Where the check runs; absent, the platform the app previews on by
	 *  default (Web Apps when it runs on both, else its only platform). */
	platform?: Platform,
): Promise<FormEvaluationContext> {
	async function authorize() {
		if (ctx.appId) {
			const access = await resolveAppScope(ctx.appId, ctx.userId, "view");
			if (access.projectId !== ctx.projectId)
				throw new FormEvaluationInputError(
					"The app moved to another Project. Reload it before evaluating.",
				);
			return access.role;
		}
		const role = await projectRoleFor(ctx.userId, ctx.projectId);
		if (!role || !roleAllowsApp(role, "view"))
			throw new FormEvaluationInputError(
				"Project access is no longer available.",
			);
		return role;
	}
	const role = await authorize();
	const db = await getAuthDb();
	const user = await db
		.selectFrom("auth_user")
		.select(["id", "name", "email"])
		.where("id", "=", ctx.userId)
		.executeTakeFirst();
	if (!user)
		throw new FormEvaluationInputError("The authoring account is unavailable.");
	const doc = ctx.snapshot.doc;
	/* The check runs on one platform the app declares. A check has no
	 * browser window: Android's id is fresh per call and Web Apps' window is
	 * 1280 wide. */
	const declared = declaredPlatforms(doc);
	if (platform !== undefined && !declared.includes(platform))
		throw new FormEvaluationInputError(
			platformUnavailableSentence(platform, "the form"),
		);
	const device = serverPreviewDevice({
		platform: effectivePreviewPlatform(declared, platform),
		appLanguage: previewAppLanguage(doc.localization, form?.language),
	});
	const projectSpace = ctx.appId
		? await previewProjectSpaceFor({
				appId: ctx.appId,
				projectId: ctx.projectId,
				actorUserId: ctx.userId,
				role,
			})
		: null;
	const persona =
		personaUuid === undefined ? undefined : doc.personas?.[personaUuid];
	if (personaUuid !== undefined && !persona)
		throw new FormEvaluationInputError("The selected worker is unavailable.");
	const identity = persona
		? previewAsPersona(user, persona, doc, projectSpace)
		: previewAsMe(user, doc, projectSpace);
	if (!identity)
		throw new FormEvaluationInputError("Worker identity is unavailable.");
	let cases: CaseDatabaseSnapshot = scenario
		? evaluationScenarioCases(doc, identity.ownerId, scenario)
		: { rows: [], indices: [] };
	const store =
		ctx.appId && scenario === undefined
			? await withProjectContext(ctx.projectId, ctx.userId, identity.ownerId)
			: undefined;
 const tableIds=extractLookupReferenceTargets(doc).tableIds;
 const needsGroups=appReadsWorkerGroups(doc);
 const scope={projectId:ctx.projectId,actorId:ctx.userId,role};
 const workerData=ctx.appId&&(tableIds.length||store||needsGroups)?await readWorkerLookupProjection({
   scope:{appId:ctx.appId,projectId:ctx.projectId,actorUserId:ctx.userId},
   grant:ctx.dataGrant??{kind:"architect",authority:lookupAgentScope(ctx)},
   personaUuid:workerUuidSchema.optional().parse(personaUuid),
 },tableIds,Boolean(store)||needsGroups):undefined;
 const restoreScope=workerData?.groupScope;
 const lookup=workerData??await readPreviewLookup(scope,tableIds);
	if (ctx.appId && store && restoreScope)
		cases = await store.readDeviceCaseDatabase({
			appId: ctx.appId,
			restoreScope,
		});
	if(restoreScope && needsGroups)cases={...cases,workerGroups:restoreScope.groups};
	// The places are the organization's, real in a scenario as lookup data
	// is, and loaded for an app whose forms read them, as Preview loads them.
	if (ctx.appId && appReadsPlaces(doc))
		cases = {
			...cases,
			locations: await workerLocationFixture(
				ctx.appId,
				doc,
				identity.personaUuid,
			),
		};
	const searchResults =
		form === undefined
			? undefined
			: await formSearchResults(doc, form, {
					appId: ctx.appId ?? undefined,
					projectId: ctx.projectId,
					identity,
					device,
					cases,
					lookup,
					store,
					restoreScope,
					scenario: scenario !== undefined,
				});
	const searchAnswers =
		form === undefined
			? undefined
			: formsReadSearchFormAnswers(doc, form, {
					identity,
					device,
					cases,
					lookup,
				});
	await authorize();
	return {
		identity,
		device,
		cases,
		lookup,
		...(searchAnswers === undefined ? {} : { searchAnswers }),
		// The entry's `uuid()` datums are minted in this app; the check runs
		// outside any menu, so no case was chosen before the form.
		...(!ctx.appId
			? {}
			: { session: { appId: ctx.appId, menuSelections: {} } }),
		...(searchResults === undefined ? {} : { searchResults }),
	};
}

/**
 * The Search answers a form of a menu whose forms read the search reads when
 * the check supplies none: each Search field's starting value, as the Search
 * screen fills its prompts and as Web Apps rebuilds a form opened with no
 * search behind it (`RemoteQuerySessionManager.initUserAnswers`). Supplied
 * answers are the evaluated form's own (`FormEvaluationInput.searchAnswers`),
 * and a form of any other module reads none.
 */
export function formsReadSearchFormAnswers(
	doc: BlueprintDoc,
	form: EvaluatedForm,
	world: Pick<
		FormEvaluationContext,
		"identity" | "device" | "cases" | "lookup"
	>,
): readonly { name: string; value: string }[] | undefined {
	const moduleUuid = moduleUuidOfForm(doc, form.formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (
		moduleUuid === undefined ||
		module === undefined ||
		!moduleFormsReadSearch(module)
	)
		return undefined;
	/* The form is reached only through its menu's Search screen, which opens
	 * as Preview opens it (`openSearchRunState`, which Preview's form screen
	 * reaches through `caseListRegistration.ts::readFormSearchAnswers`): a
	 * starting value, hidden value, required condition or check that reads
	 * data the worker's device lacks stops the search before the form, with
	 * answers supplied or not. None of those slots can read a session datum
	 * (`lib/domain/expression/context.ts::slotContext` gives datum supplies
	 * only to the case list filter and an advanced field's condition), so
	 * the screen opens over no case list step's datums. */
	let defaults: ReturnType<typeof openSearchRunState>["defaults"];
	try {
		defaults = openSearchRunState(
			moduleUuid,
			module.caseListConfig?.searchInputs ?? [],
			previewSessionValues(world.identity, world.device),
			{
				doc,
				moduleUuid,
				lookup: previewLookupData(world.lookup),
				caseDatabase: world.cases,
			},
		).defaults;
	} catch (error) {
		throw searchRefusalInputError(
			error,
			resolveAppLanguage(doc.localization, form.language),
			world.identity.personaUuid === undefined
				? undefined
				: doc.personas?.[world.identity.personaUuid]?.name,
			world.lookup,
		);
	}
	if (form.searchAnswers !== undefined) return undefined;
	return [...defaults].map(([name, value]) => ({ name, value }));
}

/**
 * A read of data the worker's device lacks (a place key of a worker assigned
 * nowhere) stops the search on a phone, or the case list where the Search
 * action's condition read it (`surfacedDataRefusal.ts`): the check says so in
 * the words Preview shows it in. Every other error is returned as it is, to
 * be thrown.
 */
function searchRefusalInputError(
	error: unknown,
	language: ReturnType<typeof resolveAppLanguage>,
	worker: string | undefined,
	lookup: FormEvaluationContext["lookup"],
): unknown {
	const surfaced = error instanceof SurfacedDataRefusal ? error : undefined;
	const refused = surfaced?.refusal ?? serverPreviewDataRefusalOf(error);
	if (refused === undefined) return error;
	const copy = dataRefusalCopy(
		language,
		surfaced?.surface ?? "search",
		previewDataRefusalSubject(refused.reason, previewLookupData(lookup)),
		worker === undefined ? {} : { worker },
	);
	return new FormEvaluationInputError(`${copy.title}. ${copy.body}`);
}

/**
 * What the search of the form's module found, for a form that reads it
 * (`results:inline`): the module's search run with the given answers, or
 * Search pressed with its defaults, over the Project's open records and
 * capped as Preview's read is (`serverSearchRead.ts`). A device reaches such a
 * form only through that search, so a form that does not read it needs none.
 */
export async function formSearchResults(
	doc: BlueprintDoc,
	form: EvaluatedForm,
	world: {
		readonly appId: string | undefined;
		readonly projectId: string;
		readonly identity: FormEvaluationContext["identity"];
		readonly device: FormEvaluationContext["device"];
		readonly cases: CaseDatabaseSnapshot;
		readonly lookup: FormEvaluationContext["lookup"];
		readonly store: CaseStore | undefined;
		readonly restoreScope: RestoreScope | undefined;
		readonly scenario: boolean;
	},
): Promise<SearchResultsSnapshot | undefined> {
	const moduleUuid = moduleUuidOfForm(doc, form.formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (
		moduleUuid === undefined ||
		module === undefined ||
		!moduleFormsReadSearch(module) ||
		!formReadsSearchResults(doc, form.formUuid)
	)
		return undefined;
	if (world.scenario)
		throw new FormEvaluationInputError(
			"This form reads what its module's search found, and test records give the search nothing to run over. Leave out the scenario to search the app's records, or start an app test that runs the search before opening the form.",
		);
	const searchWorld = {
		doc: { ...doc, caseTypes: doc.caseTypes ?? [] },
		language: resolveAppLanguage(doc.localization, form.language),
		appId: world.appId ?? doc.appId,
		projectId: world.projectId,
		identity: world.identity,
		device: world.device,
		deviceCases: world.cases,
		lookup: world.lookup,
		caseTypeSchemas: buildCaseTypeMap(doc),
		timeZone: viewerTimeZone(),
		restoreScope: world.restoreScope ?? { ownerIds: [] },
		selections: {},
	};
	const refuse = (reason: "no-record-list" | "parent-required") =>
		new FormEvaluationInputError(
			reason === "parent-required"
				? "This form's search reads the records of a parent chosen before it, which a form check cannot choose. Start an app test to choose the parent and run the search."
				: "This form's menu has no record list to search.",
		);
	const refusing = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			throw searchRefusalInputError(
				error,
				searchWorld.language,
				world.identity.personaUuid === undefined
					? undefined
					: doc.personas?.[world.identity.personaUuid]?.name,
				world.lookup,
			);
		}
	};
	/* The search screen first, as the worker reaches it: a Search action its
	 * display condition hides is one the worker never runs, so there is no
	 * search for the form to read, whatever answers are supplied. */
	const opened = await refusing(() =>
		serverRecordsRead(
			searchWorld,
			{
				moduleUuid,
				...(form.searchAnswers === undefined
					? {}
					: { submitted: form.searchAnswers }),
			},
			refuse,
		),
	);
	if (!opened.search.relevant)
		throw new FormEvaluationInputError(
			"This form reads what its module's search found, but the module's Search action is hidden for this worker: its display condition is false here, so the worker never runs the search and the form cannot open. Check the form as a worker the Search action shows for (personaUuid), or change the Search action's display condition so this worker sees it.",
		);
	const { search, read, refusal } =
		form.searchAnswers === undefined
			? await refusing(() =>
					serverRecordsRead(searchWorld, { moduleUuid, answers: [] }, refuse),
				)
			: opened;
	const [firstError] = Object.values(search.errors);
	if (firstError !== undefined)
		throw new FormEvaluationInputError(
			`The search before this form did not pass its checks: ${firstError} Supply searchAnswers the search accepts.`,
		);
	if (refusal !== undefined) throw new FormEvaluationInputError(refusal);
	/* An unpublished workspace has no records, so its search finds none. */
	if (world.store === undefined) return { rows: [], totalMatches: 0 };
	const { store } = world;
	const found = await refusing(() => serverSearchResults(store, read));
	if (found === undefined)
		throw new FormEvaluationInputError(
			"The search before this form did not complete. Supply searchAnswers for each of its required inputs.",
		);
	return found;
}
