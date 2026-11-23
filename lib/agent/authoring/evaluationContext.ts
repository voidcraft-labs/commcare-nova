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
	type SearchInputDef,
	type Uuid,
} from "@/lib/domain";
import {
	type LanguageTag,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import { declaredPlatforms, type Platform } from "@/lib/domain/platforms";
import { LookupError } from "@/lib/lookup/errors";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import { previewDataRefusalSubject } from "@/lib/preview/engine/dataRefusal";
import { dateRangeInputErrors } from "@/lib/preview/engine/dateRangeInputValidation";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import {
	type EvaluationScenario,
	evaluationScenarioCases,
} from "@/lib/preview/engine/evaluationScenario";
import { appReadsPlaces } from "@/lib/preview/engine/expressionCaseReads";
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
import { resolveRestoreScope } from "@/lib/preview/engine/restoreScope";
import {
	openSearchRunState,
	searchInputAnswerKeys,
	withHiddenValues,
} from "@/lib/preview/engine/searchRunState";
import { serverPreviewDataRefusalOf } from "@/lib/preview/engine/serverDataRefusal";
import {
	serverRecordsRead,
	serverSearchResults,
} from "@/lib/preview/engine/serverSearchRead";
import { SurfacedDataRefusal } from "@/lib/preview/engine/surfacedDataRefusal";
import { workerLocationFixture } from "@/lib/preview/engine/workerLocationFixture";
import { readPreviewLookup } from "@/lib/preview/engine/workerLookupScope";
import {
	type CaseDatabaseSnapshot,
	formReadsSearchResults,
	formReadsSearchScore,
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
	const restoreScope =
		ctx.appId && store
			? await resolveRestoreScope({
					appId: ctx.appId,
					identity,
					blueprint: doc,
				})
			: undefined;
	if (ctx.appId && store && restoreScope)
		cases = await store.readDeviceCaseDatabase({
			appId: ctx.appId,
			restoreScope,
		});
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
	const tableIds = extractLookupReferenceTargets(doc).tableIds;
	const scope = { projectId: ctx.projectId, actorId: ctx.userId, role };
	const lookup = await readPreviewLookup(scope, tableIds).catch(
		(error: unknown) => {
			if (error instanceof LookupError && error.code === "storage_limit")
				throw new FormEvaluationInputError(error.message);
			throw error;
		},
	);
	const search =
		form === undefined
			? {}
			: await formSearchContext(doc, form, {
					appId: ctx.appId ?? undefined,
					identity,
					device,
					cases,
					lookup,
					store,
					restoreScope,
					scenario: scenario !== undefined,
				});
	await authorize();
	return {
		identity,
		device,
		cases,
		lookup,
		...search,
		// The entry's `uuid()` datums are minted in this app; the check runs
		// outside any menu, so no case was chosen before the form.
		...(!ctx.appId
			? {}
			: { session: { appId: ctx.appId, menuSelections: {} } }),
	};
}

/** Only a worker's public endpoints belong in an author-supplied range. A
 * completed query has its own trusted answer representation. */
function checkSuppliedSearchAnswers(
	form: EvaluatedForm,
	fields: readonly SearchInputDef[],
): void {
	if (!form.searchAnswers) return;
	const values = new Map<string, string>();
	for (const { name, value } of form.searchAnswers) {
		if (values.has(name))
			throw new FormEvaluationInputError(
				`Supply each Search answer once. ${name} appears more than once.`,
			);
		values.set(name, value);
	}
	const rangeNames = new Set(
		fields
			.filter((field) => field.kind !== "hidden" && field.type === "date-range")
			.map((field) => field.name),
	);
	if (
		[...values.keys()].some(
			(name) => /:(starting|opening)$/.test(name) || rangeNames.has(name),
		)
	)
		throw new FormEvaluationInputError(
			"For a date range, supply each endpoint once as name:from and name:to.",
		);
	const hiddenNames = new Set(
		fields.filter((field) => field.kind === "hidden").map(({ name }) => name),
	);
	const allowed = searchInputAnswerKeys(fields);
	for (const [key, value] of values) {
		if (hiddenNames.has(key))
			throw new FormEvaluationInputError(
				`Search answer ${key} is a hidden value: the search works it out when the worker searches, and the form reads that value. Leave it out of searchAnswers.`,
			);
		if (!allowed.has(key))
			throw new FormEvaluationInputError(
				`Search answer ${key} is unavailable. Use a visible Search field name or its two date endpoints.`,
			);
		if (key.endsWith(":blank") && value !== "true")
			throw new FormEvaluationInputError(
				`Search answer ${key} says the worker also searched for blank, so its value is true. Leave it out where they did not.`,
			);
	}
	for (const name of rangeNames) {
		if (values.has(name + ":from") !== values.has(name + ":to"))
			throw new FormEvaluationInputError(
				`For ${name}, supply both ${name}:from and ${name}:to, or leave both out.`,
			);
	}
	const [error] = dateRangeInputErrors(fields, values).values();
	if (error)
		throw new FormEvaluationInputError(
			`${error}. Supply both dates as YYYY-MM-DD, with the start on or before the end.`,
		);
}

/**
 * The Search answers a form of a menu whose forms read the search reads: the
 * answers the check supplies (`FormEvaluationInput.searchAnswers`), or, where
 * it supplies none, each Search field's starting value, as the Search screen
 * fills its prompts and as Web Apps rebuilds a form opened with no search
 * behind it (`RemoteQuerySessionManager.initUserAnswers`). Either way each
 * hidden value is the one the search works out, which no worker answers. A
 * form of any other module reads none.
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
	checkSuppliedSearchAnswers(form, module?.caseListConfig?.searchInputs ?? []);
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
	let hidden: ReturnType<typeof openSearchRunState>["defaults"];
	try {
		const opened = openSearchRunState(
			moduleUuid,
			module.caseListConfig?.searchInputs ?? [],
			previewSessionValues(world.identity, world.device),
			{
				doc,
				moduleUuid,
				lookup: previewLookupData(world.lookup),
				caseDatabase: world.cases,
			},
		);
		defaults = opened.defaults;
		/* The device seeds each hidden prompt's value as it builds the Search
		 * screen (`RemoteQuerySessionManager.initUserAnswers`), so the form
		 * reads it whatever the worker answered. */
		hidden = opened.resolveHidden();
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
	const answered =
		form.searchAnswers === undefined
			? defaults
			: new Map(form.searchAnswers.map(({ name, value }) => [name, value]));
	return [...withHiddenValues(answered, hidden)].map(([name, value]) => ({
		name,
		value,
	}));
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
export async function formSearchContext(
	doc: BlueprintDoc,
	form: EvaluatedForm,
	world: {
		readonly appId: string | undefined;
		readonly identity: FormEvaluationContext["identity"];
		readonly device: FormEvaluationContext["device"];
		readonly cases: CaseDatabaseSnapshot;
		readonly lookup: FormEvaluationContext["lookup"];
		readonly store: CaseStore | undefined;
		readonly restoreScope: RestoreScope | undefined;
		readonly scenario: boolean;
	},
): Promise<Pick<FormEvaluationContext, "searchAnswers" | "searchResults">> {
	const moduleUuid = moduleUuidOfForm(doc, form.formUuid);
	const module = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (
		moduleUuid === undefined ||
		!module ||
		!moduleFormsReadSearch(module) ||
		!formReadsSearchResults(doc, form.formUuid)
	) {
		const searchAnswers = formsReadSearchFormAnswers(doc, form, world);
		return searchAnswers === undefined ? {} : { searchAnswers };
	}
	checkSuppliedSearchAnswers(form, module.caseListConfig?.searchInputs ?? []);
	if (world.scenario)
		throw new FormEvaluationInputError(
			"This form reads what its module's search found, and test records give the search nothing to run over. Leave out the scenario to search the app's records, or start an app test that runs the search before opening the form.",
		);
	const searchWorld = {
		doc: { ...doc, caseTypes: doc.caseTypes ?? [] },
		language: resolveAppLanguage(doc.localization, form.language),
		appId: world.appId ?? doc.appId,
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
	// A single query manager supplies both its submitted answers and its
	// Results. An automatic search keeps Core's initial answers; a visible
	// screen sends what its worker can see and change.
	const { search, read, refusal } = await refusing(() =>
		serverRecordsRead(
			searchWorld,
			{
				moduleUuid,
				completeForForm: true,
				answers: form.searchAnswers,
			},
			refuse,
		),
	);
	if (!search.relevant)
		throw new FormEvaluationInputError(
			"This form reads what its module's search found, but the module's Search action is hidden for this worker. You can choose a worker who sees Search or change its display condition.",
		);
	const [firstError] = Object.values(search.errors);
	if (firstError !== undefined)
		throw new FormEvaluationInputError(
			`The search before this form did not pass its checks: ${firstError} Supply searchAnswers the search accepts.`,
		);
	if (refusal !== undefined) throw new FormEvaluationInputError(refusal);
	if (!search.hasSubmitted || search.submitted === undefined)
		throw new FormEvaluationInputError(
			"The search before this form did not complete. Supply answers for each of its required inputs.",
		);
	/* An unpublished workspace has no records, so its search finds none. */
	if (world.store === undefined)
		return {
			searchAnswers: search.submitted,
			searchResults: { rows: [], totalMatches: 0 },
		};
	const { store } = world;
	const found = await refusing(() =>
		serverSearchResults(store, read, formReadsSearchScore(doc, form.formUuid)),
	);
	if (found === undefined)
		throw new FormEvaluationInputError(
			"The search before this form did not complete. Supply searchAnswers for each of its required inputs.",
		);
	return { searchAnswers: search.submitted, searchResults: found };
}
