import "server-only";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { getSession } from "@/lib/auth-utils";
import {
	type CaseStore,
	type RestoreScope,
	withProjectContext,
} from "@/lib/case-store";
import {
	resolveAppScope,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { syncUsercaseRow, workerFromPersona } from "@/lib/db/syncUsercaseRow";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import {
	mergeOwnRecords,
	ownRecordValue,
	type PersistableDoc,
	personasOf,
	personaUserData,
	type UserCollections,
	type UsercaseWorker,
} from "@/lib/domain";
import { log } from "@/lib/logger";
import type { LookupScope } from "@/lib/lookup/types";
import { schemaHealingCaseStore } from "./caseDataBindingHelpers";
import {
	previewAsMe,
	previewAsPersona,
	type ResolvedPreviewIdentity,
} from "./identity";
import { resolveRestoreScope } from "./restoreScope";

// Request authentication stays outside the production I/O helpers, which also
// serve explicitly authorized background and disposable-test transactions.
/**
 * Resolve a member identity, or project a persona from a document the caller
 * already owns. Member-only case-data actions use this low-level helper;
 * app-facing persona selectors use `resolveAuthorizedPreviewContext` so access
 * is proven before the document is loaded. `null` means no authenticated
 * worker. The client never supplies an identity to an action.
 */
export async function resolvePreviewIdentity(
	doc?: UserCollections,
	personaUuid?: string,
	projectSpace?: string | null,
): Promise<ResolvedPreviewIdentity | null> {
	const session = await getSession();
	if (!session) return null;
	if (doc === undefined || personaUuid === undefined) {
		return previewAsMe(session.user, doc, projectSpace);
	}
	// This low-level projection is used only when the caller already owns the
	// document. App-facing selectors use `resolveAuthorizedPreviewContext`,
	// whose stale-persona arm refuses rather than changing worker identities.
	const persona = ownRecordValue(personasOf(doc), personaUuid);
	if (persona === undefined)
		return previewAsMe(session.user, doc, projectSpace);
	return previewAsPersona(session.user, persona, doc, projectSpace);
}

/**
 * One authorized action context. Membership is proven before any blueprint
 * read, the selected persona resolves only from that authorized snapshot,
 * and the store keeps the Nova actor separate from the CommCare owner.
 */
export type AuthorizedPreviewContext =
	| { kind: "unauthenticated" }
	| { kind: "persona-unavailable"; message: string }
	| {
			kind: "ready";
			identity: ResolvedPreviewIdentity;
			store: CaseStore;
			scope: LookupScope;
			blueprint?: PersistableDoc;
			baseSeq?: number;
			/**
			 * What this worker's device would hold — pass it to every RUNNING
			 * read and to none of the authoring ones.
			 *
			 * It rides here rather than on `ResolvedPreviewIdentity` because it
			 * is not part of the evaluation world. The identity is the ONE
			 * contract the browser and the server both speak, and the browser
			 * cannot derive this: expanding a persona's assignments into the
			 * places it receives cases from reads the app's place tree out of
			 * Postgres. Putting a server-only field on the shared identity would
			 * make the client's copy quietly wrong, and `samePreviewIdentity`
			 * would then compare a field only one side can fill.
			 */
			restoreScope: RestoreScope;
	  };

export const PERSONA_UNAVAILABLE_MESSAGE =
	"The selected preview persona is no longer available. Choose another worker and try again.";

export async function resolveAuthorizedPreviewContext(args: {
	readonly appId: string;
	readonly personaUuid?: string;
	readonly required: AppCapability;
	/** Submission program derivation needs the committed blueprint even while
	 * previewing as the signed-in member. Persona selection implies a load. */
	readonly loadBlueprint?: boolean;
}): Promise<AuthorizedPreviewContext> {
	const session = await getSession();
	const memberIdentity = previewAsMe(session?.user);
	if (memberIdentity === null) return { kind: "unauthenticated" };

	// The app id is client input. Blueprint-needed paths use the locked
	// authorization snapshot so membership, Project, cursor, and document
	// cannot straddle a concurrent app move or commit. Member-only paths avoid
	// the full document through the lightweight scope resolver.
	const needsBlueprint =
		args.loadBlueprint === true || args.personaUuid !== undefined;
	const snapshot = needsBlueprint
		? await resolveAuthorizedAppSnapshot(
				args.appId,
				memberIdentity.actorUserId,
				args.required,
			)
		: undefined;
	const access =
		snapshot ??
		(await resolveAppScope(
			args.appId,
			memberIdentity.actorUserId,
			args.required,
		));
	const blueprint = snapshot?.app.blueprint;
	if (needsBlueprint && blueprint === undefined) {
		throw new Error("The app changed while Preview was loading it.");
	}

	/* The SAME project space the client form engine sees. This identity is
	 * what binds `sessionUser` for the SQL compiler, so leaving it out here
	 * while the browser's copy carries it would make one expression answer
	 * two ways depending on which side evaluated it — the hardest kind of
	 * difference to notice, because both halves look right alone. */
	const projectSpace = await previewProjectSpaceFor({
		appId: args.appId,
		projectId: access.projectId,
		role: access.role,
		actorUserId: memberIdentity.actorUserId,
	});

	/* `memberIdentity` above proved the session exists, so every
	 * `previewAsMe` here returns non-null for the same user; the earlier
	 * `?? memberIdentity` fallbacks were unreachable and the no-blueprint
	 * identity was rebuilt and discarded whenever one was loaded. */
	let identity =
		blueprint === undefined
			? (previewAsMe(session?.user, undefined, projectSpace) ?? memberIdentity)
			: memberIdentity;
	if (blueprint !== undefined) {
		if (args.personaUuid === undefined) {
			identity =
				previewAsMe(session?.user, blueprint, projectSpace) ?? memberIdentity;
		} else {
			const persona = ownRecordValue(personasOf(blueprint), args.personaUuid);
			if (persona === undefined) {
				return {
					kind: "persona-unavailable",
					message: PERSONA_UNAVAILABLE_MESSAGE,
				};
			}
			const resolved = previewAsPersona(
				session?.user,
				persona,
				blueprint,
				projectSpace,
			);
			if (resolved === null) return { kind: "unauthenticated" };
			identity = resolved;
		}
	}

	const store = schemaHealingCaseStore(
		await withProjectContext(
			access.projectId,
			identity.actorUserId,
			identity.ownerId,
		),
		{ appId: args.appId },
	);
	// The worker's own case, created if this is the first time anyone previewed
	// as them. The commit path syncs it whenever a worker CHANGES, but a
	// persona authored before the usercase existed has no row and nothing would
	// ever give it one — and `#user/<prop>` resolves from `casedb`, so the
	// difference is visible immediately as blank worker data in a running form.
	//
	// Best-effort: previewing must not fail because a bookkeeping row could not
	// be written. The projection on `identity` still answers `#user/` from the
	// same derivation, so a failed create degrades to exactly today's behaviour
	// rather than to a broken screen.
	const identityOnRecord = await withMaterializedUsercase({
		appId: args.appId,
		identity,
		blueprint,
		store,
	});

	return {
		kind: "ready",
		identity: identityOnRecord,
		restoreScope: await resolveRestoreScope({
			appId: args.appId,
			identity: identityOnRecord,
			blueprint,
		}),
		store,
		scope: {
			projectId: access.projectId,
			actorId: identityOnRecord.actorUserId,
			role: access.role,
		},
		...(blueprint !== undefined && { blueprint }),
		...(snapshot !== undefined && { baseSeq: snapshot.baseSeq }),
	};
}

/**
 * Point the identity's usercase at the stored row, creating it if it is
 * missing.
 *
 * Two jobs, and they belong together because the second needs the first's
 * result. The commit path owns keeping a worker's case in STEP; this owns its
 * EXISTENCE, for the two workers the commit path structurally cannot reach: a
 * persona authored before this feature existed, and the signed-in member, who
 * is a worker Nova never commits a document about.
 *
 * Then the row wins. `#user/<prop>` compiles to a `casedb` join
 * (`app_manager/xpath.py::UsercaseXPath.case()`), so the ROW is what a device
 * reads and the derived record is only ever an input to it. The two can
 * genuinely differ today: `usercaseChangedFields` never removes a key, so a
 * property dropped from the worker-property catalog is still on the row while
 * the derivation has forgotten it — and a device would still answer with it.
 * Reading the row is what keeps Preview's answer and the field's answer the
 * same one.
 *
 * Best-effort by design. A worker whose row could not be written still gets a
 * running preview off the derived record, which is what this returns
 * unchanged — a case list that will not load is a far worse answer than a
 * usercase value that is momentarily derived rather than stored.
 *
 * `projectSpace` is deliberately null. The CommCare domain is a deployment
 * fact rather than a document one, and an absent `commcare_project` reads
 * blank on a device, which is what an unpublished app has.
 */
async function withMaterializedUsercase(args: {
	readonly appId: string;
	readonly identity: ResolvedPreviewIdentity;
	readonly blueprint: PersistableDoc | undefined;
	readonly store: CaseStore;
}): Promise<ResolvedPreviewIdentity> {
	const { appId, identity, blueprint, store } = args;
	if (blueprint === undefined) return identity;
	const persona =
		identity.personaUuid === undefined
			? undefined
			: ownRecordValue(personasOf(blueprint), identity.personaUuid);
	// Previewing as the signed-in member: they are a worker too, and HQ gives
	// every worker a usercase. The session's username is the honest name — a
	// member is a Nova account rather than a worker the app defines, so there
	// is nothing else to call them.
	const memberName = identity.session.context.username ?? identity.ownerId;
	const worker: UsercaseWorker =
		persona === undefined
			? {
					id: identity.ownerId,
					username: memberName,
					personName: memberName,
					email: "",
					locationIds: [],
				}
			: workerFromPersona(persona);
	const authored =
		persona === undefined ? {} : personaUserData(persona, blueprint);
	try {
		const { stored } = await syncUsercaseRow(store, {
			appId,
			worker,
			authored,
			doc: blueprint,
			projectSpace: null,
			// Existence only. Keeping the row in step is the commit path's job,
			// and a diff here would overwrite whatever a form last wrote onto
			// the record with the persona's own blank for that property.
			ensureOnly: true,
		});
		// `case_name` is a column rather than a property, so the row's
		// properties never carry it and the derived record is the only place it
		// lives. Layering the row OVER the record keeps it.
		return {
			...identity,
			usercase: mergeOwnRecords(identity.usercase, stored),
		};
	} catch (err) {
		log.warn("[preview] usercase row ensure failed", {
			appId,
			workerId: worker.id,
			error: err instanceof Error ? err.message : String(err),
		});
		return identity;
	}
}
