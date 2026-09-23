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
import { memberOwnerIds, personaOwnerIds } from "@/lib/organization/ownerSets";
import { viewerTimeZone } from "../engine/caseDataBindingClient";
import { previewAsMe, previewAsPersona } from "../engine/identity";
import { previewLookupData } from "../engine/lookupEvaluation";
import { XPathDate } from "../xpath/types";
import type { AppTestSnapshot, AppTestState } from "./types";

export function appTestIdentity(
	snapshot: AppTestSnapshot,
	personaUuid: Uuid | null,
) {
	const persona =
		personaUuid === null
			? undefined
			: ownRecordValue(snapshot.blueprint.personas ?? {}, personaUuid);
	if (personaUuid !== null && !persona)
		throw new Error("This Preview identity is no longer available.");
	const identity = persona
		? previewAsPersona(
				snapshot.user,
				persona,
				snapshot.blueprint,
				snapshot.projectSpace,
			)
		: previewAsMe(snapshot.user, snapshot.blueprint, snapshot.projectSpace);
	if (!identity) throw new Error("The signed-in author is unavailable.");
	return identity;
}

/** No caller supplies an acting user: the authenticated scope is compared to
 * the pinned source user, and worker identity comes only from the saved app. */
export async function withAppTestContext<T>(
	tx: Transaction<Database>,
	scope: AppTestScope & { testId: string; blueprintSeq: number },
	snapshot: AppTestSnapshot,
	state: AppTestState,
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
	state: AppTestState,
) {
	const doc = hydratePersistedBlueprint(snapshot.blueprint);
	const persona =
		state.personaUuid === null ? undefined : doc.personas?.[state.personaUuid];
	const identity = appTestIdentity(snapshot, state.personaUuid);
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
	return {
		// FormEngine workers inherit this process's local timezone. SQL must
		// use it too, independently of the database connection's timezone.
		clock: {
			timeZone: viewerTimeZone(),
			today: XPathDate.fromJSDateOnly(new Date()).toISOString(),
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
		restoreScope: {
			ownerIds: persona
				? personaOwnerIds(doc, persona, snapshot.locations)
				: memberOwnerIds(scope.actorUserId),
		},
		lookup: previewLookupData({
			...snapshot.lookup,
			rowsByTable: new Map(snapshot.lookup.rows),
		}),
	};
}
export type AppTestContext = Awaited<ReturnType<typeof contextFor>>;
