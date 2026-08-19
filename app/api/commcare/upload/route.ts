/**
 * Publish an app to CommCare HQ: POST /api/commcare/upload.
 *
 * The route is a thin authorization and transport shell. Everything a
 * publish MEANS lives in `lib/deployment/service.ts::publishAppToHq`, so
 * this path and the MCP `upload_app_to_hq` tool share one lifecycle
 * instead of hand-rolling two that drift apart.
 *
 * That lifecycle records what happened. A publish is not a fire-and-forget
 * POST any more: it creates or advances a durable deployment for the
 * (app, Project, server, domain) target, records the CommCare HQ app it
 * created or updated in place, and hands back the state, the preflight
 * findings, and the setup instructions the target still needs by hand.
 * Whether to update or create is decided server-side from the deployment
 * ledger; the request shape carries no say in it.
 *
 * A preflight refusal answers 200 with an `incomplete` deployment rather
 * than an error status. That is deliberate: the request succeeded, the
 * deployment is the answer, and the caller renders which edge stopped it.
 * A 4xx here would throw away the record that says where to retry from.
 *
 * `adopt_resources` is the one field that says something about the target
 * rather than the app. Nova never takes over a CommCare HQ resource because
 * a name matched, so a name clash refuses; sending the exact Nova table ids
 * back is how a person says "yes, that one is mine". It is per-request and
 * never remembered as a preference: the next publish decides again.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug } from "@/lib/commcare/client";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCommCareSettings } from "@/lib/db/settings";
import { previewProjectSpaceFor } from "@/lib/deployment/previewSpace";
import { leftBehindResources } from "@/lib/deployment/resources";
import {
	currentResourceIdentities,
	publishAppToHq,
} from "@/lib/deployment/service";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";

/**
 * Read the explicit adoption list off the request.
 *
 * Anything that is not a list of strings is a malformed request rather than
 * a request to adopt nothing, because silently reading it as an empty list
 * would turn a client bug into a refused publish nobody can explain.
 */
function readAdoptResourceIds(value: unknown): readonly string[] {
	if (value === undefined || value === null) return [];
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throw new ApiError(
			"Which existing tables to use has to be a list of table ids.",
			400,
		);
	}
	return value as readonly string[];
}

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		// Cap the body before materializing it. Only identifiers cross the
		// wire; the blueprint is loaded server-side from the app row.
		const body = (await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES)) as {
			domain?: string;
			appName?: string;
			appId?: string;
			adopt_resources?: unknown;
		} | null;

		if (!body) throw new ApiError("App data is required", 400);
		if (!body.domain?.trim()) {
			throw new ApiError("Project space is required", 400);
		}
		if (!isValidDomainSlug(body.domain.trim())) {
			throw new ApiError("Invalid project space name", 400);
		}
		if (!body.appName?.trim()) {
			throw new ApiError("App name is required", 400);
		}
		if (typeof body.appId !== "string") {
			throw new ApiError("App data is required", 400);
		}
		/* Validated to a list of strings here rather than trusted: these ids
		 * decide whether Nova writes over a CommCare HQ table it did not
		 * make, and `publishAppToHq` matches them against the exact conflicts
		 * it found, so anything else is simply not a conflict it can resolve.
		 * Absent means adopt nothing. */
		const adoptResourceIds = readAdoptResourceIds(body.adopt_resources);

		/* Publishing to CommCare HQ requires edit, not view: a viewer can't
		 * push a shared app out of the Project. An `AppAccessError` maps to
		 * 404, so a foreign app is indistinguishable from a missing one. */
		const access = await resolveAppAccess(body.appId, session.user.id, "edit");
		const { app } = access;

		/* Which CommCare deployment the stored key belongs to. A key only
		 * authenticates against the server that issued it, so the server is
		 * part of the deployment's identity rather than a display detail.
		 * The settings read validates the stored server against the closed
		 * catalog itself, collapsing an unrecognized one to not-configured,
		 * so a configured result always names a real installation. */
		const settings = await getCommCareSettings(session.user.id);
		if (!settings.configured) {
			throw new ApiError(
				"CommCare HQ is not configured. Add your API key in Settings.",
				400,
			);
		}

		const scope = {
			appId: body.appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: session.user.id,
		};
		const doc = hydratePersistedBlueprint(app.blueprint as PersistableDoc);
		const outcome = await publishAppToHq({
			scope,
			doc,
			compiledAtSeq: app.mutation_seq,
			appName: body.appName.trim(),
			server: settings.server,
			domain: body.domain.trim(),
			adoptResourceIds,
		});

		/* Whether THIS publish got the app there, which is not the same as
		 * where the deployment stands. A blocked preflight against an app
		 * that is already released leaves the record released, because it
		 * still is — reading success off the state would report a publish
		 * that never happened as a success. */
		const succeeded = outcome.landed;
		/* What Preview may honestly name now. Resolved here rather than in
		 * the browser because only the server can see whether this app is
		 * live on more than one project space, which is exactly when
		 * `commcare_project` has two real answers and Nova must name
		 * neither. */
		/* What an earlier publish left on this project space and the app no
		 * longer points at. Derived here rather than in the dialog: telling a
		 * rename (something really is sitting there) from a recreate
		 * (nothing is) needs the names the tables carry NOW, which is a
		 * server-side read. */
		const identities =
			outcome.deployment === null
				? null
				: await currentResourceIdentities(scope, doc);
		return NextResponse.json(
			{
				success: succeeded,
				/* Which way the app landed: updated in place, or created fresh.
				 * Null on a refusal, where nothing landed. */
				hq_app_action: outcome.landed ? outcome.hqAppAction : null,
				preview_project_space: await previewProjectSpaceFor(scope),
				/* Null when the app has never reached this target: a refused
				 * first publish leaves nothing durable behind, and the refusal
				 * below is the whole answer. */
				deployment: outcome.deployment,
				/* Never inferred from `deployment.superseded` by the client:
				 * a table recreated after being deleted on CommCare HQ
				 * supersedes its mapping and leaves nothing there. */
				left_behind:
					outcome.deployment === null
						? []
						: identities === null
							? outcome.deployment.superseded.filter(
									(resource) => resource.kind === "app",
								)
							: leftBehindResources(outcome.deployment, identities),
				/* Why THIS attempt stopped, when it did. The record cannot
				 * carry it: a refusal against an already-live deployment
				 * deliberately writes nothing durable. */
				refusal: outcome.refusal,
				preflight: outcome.checks,
				setup_artifact: outcome.artifact,
				warnings: outcome.warnings,
				feature_flag_requirements: outcome.featureFlags,
				url: outcome.hqAppUrl,
			},
			/* 201 only when the publish actually created the HQ app; an
			 * in-place update created no resource, so it answers 200. */
			{
				status: outcome.landed && outcome.hqAppAction === "created" ? 201 : 200,
			},
		);
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Upload failed"),
		);
	}
}
