import type { Transaction } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store";
import {
	type AppTestCaseStore,
	withAppTestNamespace,
} from "@/lib/case-store/appTestNamespace";
import type { Database } from "@/lib/case-store/sql/database";
import type { AppTestScope } from "@/lib/db/appTests";
import { syncUsercaseRow, workerFromPersona } from "@/lib/db/syncUsercaseRow";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	mergeOwnRecords,
	ownRecordValue,
	personaUserData,
	type Uuid,
} from "@/lib/domain";
import {
	type AppLanguageIdentity,
	effectiveAppLocalization,
	languageTag,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import { declaredPlatforms, type Platform } from "@/lib/domain/platforms";
import { memberOwnerIds, personaOwnerIds } from "@/lib/organization/ownerSets";
import { workerPlaceGroup } from "../engine/restoreScope";
import { viewerTimeZone } from "../engine/caseDataBindingClient";
import { previewAsMe, previewAsPersona } from "../engine/identity";
import { previewLookupData } from "../engine/lookupEvaluation";
import {
	previewAppLanguage,
	serverPreviewDevice,
} from "../engine/previewDevice";
import {
	effectivePreviewPlatform,
	platformUnavailableSentence,
	previewPlatformRules,
} from "../platform";
import { XPathDate } from "../xpath/types";
import { AppTestActionError } from "./errors";
import { lookupRowsForTestWorker } from "./lookupAccess";
import type { AppTestSessionState, AppTestSnapshot } from "./types";

export function appTestLanguage(
	snapshot: AppTestSnapshot,
	selected?: AppLanguageIdentity,
) {
	const tag = selected === undefined ? undefined : languageTag(selected);
	if (
		tag !== undefined &&
		!effectiveAppLocalization(
			snapshot.blueprint.localization,
		).languageOrder.includes(tag)
	)
		throw new AppTestActionError("Choose a language configured in this app.");
	return resolveAppLanguage(snapshot.blueprint.localization, tag);
}

/**
 * The platform a session runs on: its own, else the start's, else the one
 * the saved app previews on by default. A platform the app does not declare
 * refuses, naming the one it runs on.
 */
export function appTestPlatform(
	snapshot: AppTestSnapshot,
	requested?: Platform,
): Platform {
	const declared = declaredPlatforms(snapshot.blueprint);
	if (requested !== undefined && !declared.includes(requested))
		throw new AppTestActionError(
			platformUnavailableSentence(requested, "a session"),
		);
	return effectivePreviewPlatform(declared, requested);
}

export function appTestIdentity(
	snapshot: AppTestSnapshot,
	personaUuid: Uuid | null,
) {
	const persona =
		personaUuid === null
			? undefined
			: ownRecordValue(snapshot.blueprint.personas ?? {}, personaUuid);
	if (personaUuid !== null && !persona)
		throw new AppTestActionError(
			"This Preview identity is no longer available.",
		);
	const identity = persona
		? previewAsPersona(
				snapshot.user,
				persona,
				snapshot.blueprint,
				snapshot.projectSpace,
			)
		: previewAsMe(snapshot.user, snapshot.blueprint, snapshot.projectSpace);
	if (!identity)
		throw new AppTestActionError("The signed-in author is unavailable.");
	return identity;
}

/** No caller supplies an acting user: the authenticated scope is compared to
 * the pinned source user, and worker identity comes only from the saved app. */
export async function withAppTestContext<T>(
	tx: Transaction<Database>,
	scope: AppTestScope & { testId: string; blueprintSeq: number },
	snapshot: AppTestSnapshot,
	state: AppTestSessionState,
	body: (context: Awaited<ReturnType<typeof contextFor>>) => Promise<T>,
) {
	if (snapshot.user.id !== scope.actorUserId)
		throw new Error("The test belongs to a different author.");
	const identity = appTestIdentity(snapshot, state.personaUuid);
	return withAppTestNamespace(
		tx,
		{ ...scope, ownerId: identity.ownerId },
		async (store) => body(await contextFor(store, scope, snapshot, state)),
	);
}

async function contextFor(
	store: AppTestCaseStore,
	scope: AppTestScope,
	snapshot: AppTestSnapshot,
	state: AppTestSessionState,
) {
	const doc = hydratePersistedBlueprint(snapshot.blueprint);
	const persona =
		state.personaUuid === null ? undefined : doc.personas?.[state.personaUuid];
	const identity = appTestIdentity(snapshot, state.personaUuid);
	const groupScope = snapshot.lookup.workers?.find(
		(w) => w.personaUuid === state.personaUuid,
	)?.groupScope;
	const simulatePlaces =
		!!persona &&
		(snapshot.testPlaceIds.length > 0 ||
			snapshot.testAssignmentPersonaIds.includes(persona.uuid));
	let groupRows = groupScope?.groups ?? [];
	let ownerIds =
		groupScope?.ownerIds ??
		(persona
			? personaOwnerIds(doc, persona, snapshot.locations)
			: memberOwnerIds(scope.actorUserId));
	if (persona && simulatePlaces) {
		const reachable = personaOwnerIds(doc, persona, snapshot.locations).slice(
			1,
		);
		const places = new Map(snapshot.locations.map((p) => [p.id, p]));
		const placesInGroups = reachable.map((id) => {
			const place = places.get(id as Uuid);
			if (!place)
				throw new AppTestActionError(
					"A test place changed. You can restart this journey.",
				);
			const path = [place.name];
			let ancestor = place.parentId;
			const seen = new Set([place.id]);
			while (ancestor) {
				const parent = places.get(ancestor);
				if (!parent || seen.has(ancestor))
					throw new AppTestActionError(
						"A test place needs a complete parent path. You can check its parents and start this journey again.",
					);
				path.unshift(parent.name);
				seen.add(ancestor);
				ancestor = parent.parentId;
			}
			return workerPlaceGroup(doc, place, path);
		});
		if (groupScope && groupScope.placeGroupCount === undefined)
			throw new AppTestActionError(
				"This journey uses the groups delivered by a connected project space. You can start a separate journey for test place assignments.",
			);
		groupRows = [
			...placesInGroups,
			...groupRows.slice(groupScope?.placeGroupCount ?? 0),
		];
		ownerIds = [...new Set([persona.uuid, ...groupRows.map((g) => g.id)])];
	}
	const memberName = identity.session.context.username ?? identity.ownerId;
	const { stored } = await syncUsercaseRow(store, {
		appId: scope.appId,
		worker: persona
			? workerFromPersona(persona)
			: {
					id: identity.ownerId,
					username: memberName,
					personName: memberName,
					email: "",
					locationIds: [],
				},
		authored: persona ? personaUserData(persona, doc) : {},
		doc,
		projectSpace: snapshot.projectSpace,
		ensureOnly: true,
	});
	const language = resolveAppLanguage(doc.localization, state.language);
	return {
		language,
		/* A journey has no browser window: its device is the session's own
		 * install on Android and a 1280-wide window on Web Apps. */
		device: serverPreviewDevice({
			platform: state.platform,
			appLanguage: previewAppLanguage(doc.localization, language),
			androidDeviceId: state.androidDeviceId,
		}),
		rules: previewPlatformRules(state.platform),
		// FormEngine workers inherit this process's local timezone. SQL must
		// use it too, independently of the database connection's timezone.
		clock: {
			timeZone: viewerTimeZone(),
			today: XPathDate.localDateOf(Date.now()).toISOString(),
		},
		locations: snapshot.locations,
		testPlaceIds: snapshot.testPlaceIds,
		testAssignmentPersonaIds: snapshot.testAssignmentPersonaIds,
		doc: { ...doc, caseTypes: doc.caseTypes ?? [] },
		store,
		identity: {
			...identity,
			usercase: mergeOwnRecords(identity.usercase, stored),
		},
		caseTypeSchemas: buildCaseTypeMap(doc),
		/* The worker's claims are claim rows in the journey's namespace that
		 * the worker owns, so the owned seed reaches them and their hosts. */
		workerGroups: groupRows,
		restoreScope: { ownerIds },
		lookup: previewLookupData({
			...snapshot.lookup,
			rowsByTable: lookupRowsForTestWorker(snapshot.lookup, state.personaUuid),
		}),
	};
}
export type AppTestContext = Awaited<ReturnType<typeof contextFor>>;
