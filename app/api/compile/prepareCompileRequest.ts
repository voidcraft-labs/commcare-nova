import type { NextRequest } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { installationDownloadIssue } from "@/lib/commcare/installationProfiles";
import { isCommCareServer } from "@/lib/commcare/servers";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { withAppTx } from "@/lib/db/pg";
import {
	type DownloadTarget,
	downloadAttachmentState,
	resolveDownloadTarget,
} from "@/lib/deployment/downloadTarget";
import { downloadRefusalLines } from "@/lib/deployment/runtimeTarget";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	installationArchiveIssue,
	type PersistableDoc,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { resolvedLanguageEnglishName } from "@/lib/domain/languageRegistry/names";
import type { ExportActor } from "@/lib/export/artifacts/access";
import {
	type ExportMode,
	type PreparedExportBoundary,
	prepareExportBoundary,
} from "@/lib/export/boundaryValidation";
import { authorizeAssignmentExport } from "@/lib/export/privateAssignments";
import type { AttachmentTargetState } from "@/lib/publish/exportAdvisories";

/**
 * Everything the two CommCare export routes need once their shared front half
 * has run: the validated blueprint and its exact external-resource generation.
 * The lookup snapshot keeps its authorized Project identity because later
 * emitters must consume the generation validated here; it remains server-only.
 *
 * `download` is the project space the download is made for: for a `.ccz`
 * the one reached deployment whose addresses, HQ app id and ids the archive
 * carries, and for the import file only what scopes its attachment links.
 *
 * `attachmentTargetState` rides alongside the boundary's resolved
 * `attachmentTarget` because the two answer different questions. The emitter
 * needs the address or nothing; the person downloading the file needs to know
 * WHY there is nothing, and "no project space holds this app yet" leaves them
 * somewhere different than "several do".
 */
export type PreparedCompileRequest<M extends "ccz" | "hq-json"> =
	PreparedExportBoundary & {
		readonly appId: string;
		readonly exportActor: () => ExportActor;
		readonly download: Extract<
			DownloadTarget,
			{ format: M extends "ccz" ? "ccz" : "json" }
		>;
		readonly attachmentTargetState: AttachmentTargetState;
		readonly installationProfileUuid?: Uuid;
	};

/**
 * The shared front half of the two CommCare export routes: `/api/compile`
 * (`.ccz`) and `/api/compile/json` (HQ JSON). Both must authenticate, parse and
 * validate the posted `BlueprintDoc`, rebuild its derived `fieldParent` index,
 * run the zero-tolerance boundary gate, and resolve the app's Project resources
 * BEFORE they diverge on how they emit (package an archive vs. expand to JSON).
 * That whole preamble lives here so the routes can't drift on gate ordering,
 * schema-error shape, or external-resource generation.
 *
 * Every failure boundary throws an {@link ApiError} carrying the right status
 * and detail lines; each route's `catch` hands it to `handleApiError`. The only
 * per-route difference is the gate wording, so the caller passes the verb
 * that completes "…isn't ready to <verb>."
 */
export async function prepareCompileRequest<
	M extends Extract<ExportMode, "ccz" | "hq-json">,
>(
	req: NextRequest,
	{
		boundaryErrorVerb,
		mode,
	}: {
		boundaryErrorVerb: "compile" | "export";
		mode: M;
	},
): Promise<PreparedCompileRequest<M>> {
	const session = await requireSession(req);
	// The client sends only the app id: the blueprint loads server-side, so no
	// whole doc crosses the wire. (The auto-save persists edits within ~1s, and
	// an export is an on-demand action well after the last edit, so the loaded
	// doc is the current one.)
	const body = await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES);
	const appId = (body as { appId?: unknown } | null)?.appId;
	if (typeof appId !== "string") {
		throw new ApiError("appId is required", 400);
	}

	// Membership gate (view) + load the persisted blueprint in one read. An
	// `AppAccessError` (absent / non-member) maps to 404: the IDOR-safe
	// not-found posture.
	const privateData = (body as { privateData?: unknown })?.privateData === true;
	const access = await resolveAppAccess(
		appId,
		session.user.id,
		privateData ? "edit" : "view",
	);
	const { app } = access;

	// Hydration rebuilds derived in-memory indexes on the already-canonical
	// persisted document. It does not backfill or admit an alternate stored
	// representation.
	const docWithParent = hydratePersistedBlueprint(
		app.blueprint as PersistableDoc,
	);

	// A `.ccz` is made for one project space this app is published to, and
	// the import file for none: a reached deployment only scopes its
	// attachment links. The choice reads the ledger and, for a `.ccz` of an
	// app published nowhere, which menu's selection feeds which; it reads no
	// Project data, so a refusal costs no lookup or media read.
	const server = (body as { server?: unknown } | null)?.server;
	if (
		server !== undefined &&
		(typeof server !== "string" || !isCommCareServer(server))
	) {
		throw new ApiError("Choose US, India, or EU as the CommCare server.", 400);
	}
	const domain = (body as { domain?: unknown } | null)?.domain;
	if (domain !== undefined && (typeof domain !== "string" || domain === "")) {
		throw new ApiError("Choose a project space by its name.", 400);
	}
	const grant = () => ({
		kind: "session" as const,
		sessionId: session.session.id,
	});
	const assignmentAccess =
		privateData &&
		mode === "hq-json" &&
		typeof server === "string" &&
		isCommCareServer(server) &&
		typeof domain === "string"
			? {
					scope: {
						appId,
						projectId: access.projectId,
						actorUserId: session.user.id,
					},
					grant: grant(),
					target: { server, domain },
				}
			: undefined;
	if (privateData && !assignmentAccess)
		throw new ApiError(
			"Choose a project space for the import file with worker assignments.",
			400,
		);
	if (assignmentAccess)
		await withAppTx((tx) =>
			authorizeAssignmentExport(
				tx,
				assignmentAccess.scope,
				assignmentAccess.grant,
				assignmentAccess.target,
			),
		);
	const download = await resolveDownloadTarget(
		{
			appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: access.actorUserId,
		},
		{
			compiledAtSeq: app.mutation_seq,
			format: mode === "ccz" ? "ccz" : "json",
			...(server !== undefined && { server }),
			...(assignmentAccess && {
				assignmentDestination: assignmentAccess.target,
			}),
			...(!privateData && domain !== undefined && { domain }),
			doc: docWithParent,
		},
	);
	if ("kind" in download) {
		throw new ApiError(download.message, 422, downloadRefusalLines(download));
	}

	const rawProfile = (body as { installationProfileUuid?: unknown })
		.installationProfileUuid;
	let installationProfileUuid: Uuid | undefined;
	if (rawProfile !== undefined) {
		if (mode !== "ccz")
			throw new ApiError(
				"An import file includes the entire app. A profile can be selected for the mobile app file.",
				400,
			);
		const parsed = uuidSchema.safeParse(rawProfile);
		if (!parsed.success)
			throw new ApiError("Choose an installation profile from the app.", 400);
		installationProfileUuid = parsed.data;
		const issue =
			(download.format === "ccz"
				? installationDownloadIssue(
						docWithParent,
						installationProfileUuid,
						download.identity,
					)
				: undefined) ??
			installationArchiveIssue(
				docWithParent,
				installationProfileUuid,
				resolvedLanguageEnglishName,
			);
		if (issue) throw new ApiError(issue, 422);
	}

	// The transaction-boundary gate: zero tolerance, before any expensive
	// work. Every finding (soundness, completeness, media-state) rejects the
	// export with the rule's own actionable message: an invalid app must
	// never leave for a device or CommCare HQ, and a stale media reference
	// would otherwise make the media-ON `expandDoc` throw `requireAssetRef`
	// → opaque 500.
	const boundary = await prepareExportBoundary({
		streamMedia: true,
		archiveActor: () => ({ appId, grant: grant() }),
		assignmentAccess,
		mode,
		access: {
			projectId: access.projectId,
			role: access.role,
			actorUserId: access.actorUserId,
		},
		doc: docWithParent,
		compiledAtSeq: app.mutation_seq,
		attachmentTarget: download.attachmentTarget,
		/* A `.ccz` names each file where CommCare HQ keeps it on the project
		 * space it is made for; the import file is made for none. */
		...(download.format === "ccz" && {
			heldMediaPaths: download.mediaPaths,
			installTarget: download.runtimeTarget,
		}),
	});
	if (!boundary.ok) {
		// The concise builder copy on the detail lines: this is a
		// user-facing failure. (The SA's compile path reads the verbose
		// `message` through its own envelope, not this route.)
		throw new ApiError(
			`This app isn't ready to ${boundaryErrorVerb}. Fix the issues below, then try again.`,
			422,
			boundary.violations.map(userFacingError),
		);
	}

	return {
		...boundary.prepared,
		appId,
		exportActor: () => ({
			userId: session.user.id,
			grant: { kind: "session", sessionId: session.session.id },
		}),
		installationProfileUuid,
		download: download as PreparedCompileRequest<M>["download"],
		attachmentTargetState: downloadAttachmentState(download),
	};
}
