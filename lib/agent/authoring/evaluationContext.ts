import "server-only";
import { getAuthDb } from "@/lib/auth/db";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { withProjectContext } from "@/lib/case-store";
import { resolveAppScope } from "@/lib/db/appAccess";
import { projectRoleFor } from "@/lib/db/projectMembership";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { getLookupFixtureData, getLookupManifest } from "@/lib/lookup/service";
import { FormEvaluationInputError } from "@/lib/preview/engine/evaluateForm";
import { previewAsMe, previewAsPersona } from "@/lib/preview/engine/identity";
import { resolveRestoreScope } from "@/lib/preview/engine/restoreScope";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import type { ToolInvocationContext } from "../workspace/types";

/** Capture real, authorized data without Preview's usercase or schema writes.
 * An unpublished workspace has no case rows; Project lookup data is still real. */
export async function loadFormEvaluationContext(
	ctx: ToolInvocationContext,
	personaUuid?: string,
) {
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
	let cases: CaseDatabaseSnapshot = { rows: [], indices: [] };
	if (ctx.appId) {
		const store = await withProjectContext(
			ctx.projectId,
			ctx.userId,
			identity.ownerId,
		);
		cases = await store.readDeviceCaseDatabase({
			appId: ctx.appId,
			restoreScope: await resolveRestoreScope({
				appId: ctx.appId,
				identity,
				blueprint: doc,
			}),
		});
	}
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
	await authorize();
	return { identity, cases, lookup };
}
