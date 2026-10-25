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
	moduleOpensOnSearch,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import {
	type LanguageTag,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import { declaredPlatforms, type Platform } from "@/lib/domain/platforms";
import { getLookupFixtureData, getLookupManifest } from "@/lib/lookup/service";
import { viewerTimeZone } from "@/lib/preview/engine/caseDataBindingClient";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import {
	type EvaluationScenario,
	evaluationScenarioCases,
} from "@/lib/preview/engine/evaluationScenario";
import { appReadsPlaces } from "@/lib/preview/engine/expressionCaseReads";
import type { FormEvaluationContext } from "@/lib/preview/engine/formEvaluationTypes";
import { previewAsMe, previewAsPersona } from "@/lib/preview/engine/identity";
import {
	previewAppLanguage,
	serverPreviewDevice,
} from "@/lib/preview/engine/previewDevice";
import { resolveRestoreScope } from "@/lib/preview/engine/restoreScope";
import {
	serverRecordsRead,
	serverSearchResults,
} from "@/lib/preview/engine/serverSearchRead";
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
	const manifest = await getLookupManifest(scope);
	const requested = new Set<string>(tableIds);
	const bytes = manifest.tables
		.filter((table) => requested.has(table.id))
		.reduce((sum, table) => sum + table.dataBytes, 0);
	if (bytes > 32 * 1024 * 1024)
		throw new FormEvaluationInputError(
			"The referenced lookup data exceeds the evaluation size limit.",
		);
	const lookup = await getLookupFixtureData(scope, tableIds);
	const searchResults =
		form === undefined
			? undefined
			: await formSearchResults(doc, form, {
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
		// The entry's `uuid()` datums are minted in this app; the check runs
		// outside any menu, so no case was chosen before the form.
		...(!ctx.appId
			? {}
			: { session: { appId: ctx.appId, menuSelections: {} } }),
		...(searchResults === undefined ? {} : { searchResults }),
	};
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
		!moduleOpensOnSearch(module) ||
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
	/* The search screen first, as the worker reaches it: a Search action its
	 * display condition hides is one the worker never runs, so there is no
	 * search for the form to read, whatever answers are supplied. */
	const opened = await serverRecordsRead(
		searchWorld,
		{
			moduleUuid,
			...(form.searchAnswers === undefined
				? {}
				: { submitted: form.searchAnswers }),
		},
		refuse,
	);
	if (!opened.search.relevant)
		throw new FormEvaluationInputError(
			"This form reads what its module's search found, but the module's Search action is hidden for this worker: its display condition is false here, so the worker never runs the search and the form cannot open. Check the form as a worker the Search action shows for (personaUuid), or change the Search action's display condition so this worker sees it.",
		);
	const { search, read, refusal } =
		form.searchAnswers === undefined
			? await serverRecordsRead(
					searchWorld,
					{ moduleUuid, answers: [] },
					refuse,
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
	const found = await serverSearchResults(world.store, read);
	if (found === undefined)
		throw new FormEvaluationInputError(
			"The search before this form did not complete. Supply searchAnswers for each of its required inputs.",
		);
	return found;
}
