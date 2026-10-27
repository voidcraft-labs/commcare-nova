/**
 * POST /api/apps/[id]/attachments: initiate a form attachment upload.
 *
 * The worker-capture twin of `/api/media/upload`, and deliberately a
 * separate lane: a file a worker attaches while filling in a form is
 * data, not an authoring asset, so it never enters `media_assets`.
 *
 * Same three-step shape as the media lane, for the same reason, the
 * bytes must not travel through Cloud Run:
 *
 *   1. this route validates the request and returns a signed PUT URL,
 *   2. the browser PUTs the bytes straight to GCS,
 *   3. `[attachmentId]/confirm` verifies the object exists and flips the
 *      row to `staged`, at which point the form answer may name it.
 *
 * The route lives under `/api/apps/[id]/` rather than a new top-level
 * segment on purpose. `lib/hostnames.ts`'s allowlist matching is
 * segment-anchored and already carries `/api/apps`, so nesting here needs
 * no allowlist entry: the single most common deploy-time surprise in this
 * repo, sidestepped rather than worked around.
 *
 * There is no content-hash dedup, unlike the media lane. Two workers who
 * attach identical bytes have made two independent observations with
 * independent lifecycles; sharing one object would let one submission's
 * cleanup destroy another's evidence.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, readJsonBody } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAuthorizedAppSnapshot } from "@/lib/db/appAccess";
import {
	compensatePendingFormAttachmentInitiation,
	createPendingFormAttachment,
	FormAttachmentWriteRejectedError,
} from "@/lib/db/formAttachments";
import { isCaptureFieldKind, uuidSchema } from "@/lib/domain";
import {
	CAPTURE_EXTENSIONS_BY_KIND,
	CAPTURE_LIMITS,
	captureContentType,
	captureExtensionFor,
	captureFamilyExtensionFor,
	captureInstancePathMatchesTemplate,
	captureMimeFamilyFor,
	committedCapturePath,
	isCaptureMimeFamilyKind,
} from "@/lib/domain/captureFormats";
import {
	declaredPlatforms,
	inPlatform,
	PLATFORMS,
} from "@/lib/domain/platforms";
import { log } from "@/lib/logger";
import { createSignedUploadUrl } from "@/lib/storage/media";

const requestBodySchema = z.strictObject({
	/** One form entry: the attachment-attempt scope. Client-minted per
	 *  `activateForm`, and only ever a selector within the caller's own
	 *  rows, never authority. */
	entryKey: z.uuid(),
	/** The capture question this answers. Its kind is read from the
	 *  committed blueprint, never taken from the request. */
	fieldUuid: uuidSchema,
	/** Concrete engine path, so a replace targets one repeat instance. */
	instancePath: z.string().min(1).max(1024),
	filename: z.string().min(1).max(255),
	sizeBytes: z.number().int().positive(),
	/** The platform Preview is playing, whose limits and acceptance apply.
	 *  Checked against the committed blueprint's declaration. */
	platform: z.enum(PLATFORMS),
	/** The browser's `File.type`: a MIME type and subtype, or `""` for a file
	 *  the browser cannot type. Read only where Android admits by MIME
	 *  family, so nothing else reaches the stored row or the signed PUT. */
	contentType: z.union([
		z.literal(""),
		z
			.string()
			.max(255)
			.regex(/^[a-z]+\/[a-z0-9.+-]+$/i),
	]),
});

/** Metadata only: two uuids, a path, a filename, a number. 4 KB is
 *  generous and keeps a large body from being buffered and parsed before
 *  the schema rejects it. */
const ATTACHMENT_METADATA_MAX_BYTES = 4 * 1024;

async function whileRequestIsActive<T>(
	signal: AbortSignal,
	operation: () => Promise<T>,
): Promise<T> {
	signal.throwIfAborted();
	const boundaryClosed = Symbol("request activity boundary closed");
	let rejectAbort!: (reason: unknown) => void;
	let closeAbort!: () => void;
	const aborted = new Promise<typeof boundaryClosed>((resolve, reject) => {
		rejectAbort = reject;
		closeAbort = () => resolve(boundaryClosed);
	});
	const onAbort = () =>
		rejectAbort(signal.reason ?? new DOMException("Aborted", "AbortError"));
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		// Create the external operation only after the initial abort proof, then
		// install a losing-rejection observer before yielding. In particular, an
		// already-aborted request must not create a signer promise at all, and a
		// signer that rejects after the abort race is still observed.
		const running = operation();
		void running.catch(() => undefined);
		const result = await Promise.race([running, aborted]);
		if (result === boundaryClosed) {
			throw new Error(
				"Request activity boundary closed before signing settled.",
			);
		}
		return result;
	} finally {
		closeAbort();
		signal.removeEventListener("abort", onAbort);
	}
}

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
	try {
		const { id: appId } = await params;
		const session = await requireSession(req);
		const body = await readJsonBody(req, ATTACHMENT_METADATA_MAX_BYTES);
		if (body === null) throw new ApiError("Invalid JSON body", 400);
		const parsed = requestBodySchema.safeParse(body);
		if (!parsed.success) {
			throw new ApiError("Invalid attachment request", 400);
		}
		const {
			entryKey,
			fieldUuid,
			instancePath,
			filename,
			sizeBytes,
			platform,
			contentType: fileType,
		} = parsed.data;

		// Attaching is a data write, so it needs `edit`. The snapshot is the
		// documented one-authorized-read path and gives the Project plus the
		// committed blueprint together, so the field's kind and the tenant
		// come from the same serial winner.
		const snapshot = await resolveAuthorizedAppSnapshot(
			appId,
			session.user.id,
			"edit",
		);
		const field = snapshot.app.blueprint.fields[fieldUuid];
		const committedPath = committedCapturePath(
			snapshot.app.blueprint,
			fieldUuid,
		);
		if (field === undefined || !isCaptureFieldKind(field.kind)) {
			// Collapsed with "no such field" deliberately: which uuids exist in
			// an app is not something a caller should be able to enumerate by
			// the shape of a rejection.
			throw new ApiError(
				"That question doesn't take an attachment. Attach files only to photo, audio, video, signature, or file questions.",
				400,
			);
		}
		if (
			committedPath === undefined ||
			!captureInstancePathMatchesTemplate(
				instancePath,
				committedPath.instancePathTemplate,
			)
		) {
			throw new ApiError(
				"That attachment path is not a live instance of the selected capture question. Reload the form and try again.",
				400,
			);
		}

		if (!declaredPlatforms(snapshot.app.blueprint).includes(platform)) {
			throw new ApiError(
				"This app doesn't run on that platform. You can reload the form and try again.",
				400,
			);
		}
		const limits = CAPTURE_LIMITS[platform];
		if (sizeBytes > limits.maxBytes) {
			throw new ApiError(
				`That file is larger than the ${Math.floor(limits.maxBytes / 1_000_000)} MB limit CommCare accepts for one attachment ${inPlatform(platform)}. You can attach a smaller file.`,
				400,
			);
		}

		// What the DEVICE would accept for this exact kind, so the preview
		// cannot stage a file a real worker could never have picked. Android's
		// image, sound and video widgets take any file of their MIME family
		// (HQ's receiver takes any image, audio or video attachment); Web Apps,
		// and a signature or document question on both platforms, check the
		// kind's extension list (`entries.js::FileEntry`).
		const kind = field.kind;
		const article = /^[aeiou]/u.test(kind) ? "An" : "A";
		let extension: string;
		let contentType: string;
		if (limits.acceptance === "mime-family" && isCaptureMimeFamilyKind(kind)) {
			if (captureMimeFamilyFor(kind, fileType) === undefined) {
				throw new ApiError(
					`${article} ${kind} question accepts ${kind} files, so you can attach one of those instead.`,
					400,
				);
			}
			extension = captureFamilyExtensionFor(kind, filename);
			contentType = fileType;
		} else {
			const listed = captureExtensionFor(kind, filename);
			if (listed === undefined) {
				throw new ApiError(
					`${article} ${kind} question accepts ${CAPTURE_EXTENSIONS_BY_KIND[kind].join(", ")}, so you can attach one of those instead.`,
					400,
				);
			}
			extension = listed;
			contentType = captureContentType(listed);
		}

		const { attachmentId, attachmentName, objectKey } =
			await createPendingFormAttachment({
				appId,
				projectId: snapshot.projectId,
				expectedAppMutationSeq: snapshot.baseSeq,
				createdBy: session.user.id,
				entryKey,
				fieldUuid,
				instancePath,
				originalFilename: filename,
				extension,
				contentType,
				sizeBytes,
			});

		let upload: Awaited<ReturnType<typeof createSignedUploadUrl>>;
		try {
			// The row commits before URL signing. Bind that external gap to
			// request liveness so a browser disconnect promptly runs the same
			// exact pending-row compensation as a signing failure.
			upload = await whileRequestIsActive(req.signal, () =>
				createSignedUploadUrl({
					gcsObjectKey: objectKey,
					contentType,
					minBytes: sizeBytes,
					maxBytes: sizeBytes,
				}),
			);
			req.signal.throwIfAborted();
		} catch (signingError) {
			try {
				const compensated = await compensatePendingFormAttachmentInitiation({
					attachmentId,
					attachmentName,
					appId,
					projectId: snapshot.projectId,
					createdBy: session.user.id,
					entryKey,
					fieldUuid,
					instancePath,
					objectKey,
				});
				if (!compensated) {
					log.warn(
						"[attachments] initiate compensation lost its pending-row CAS; expiry sweep remains the fallback",
						{
							attachmentId,
							appId,
							projectId: snapshot.projectId,
						},
					);
				}
			} catch (err) {
				// Preserve the signing failure as the request result. The bounded
				// compensation is hygiene; the row's expiry and scheduled sweep are
				// the durable fallback if Postgres is unavailable or contended.
				log.warn(
					"[attachments] initiate compensation failed; expiry sweep remains the fallback",
					{
						err,
						attachmentId,
						appId,
						projectId: snapshot.projectId,
					},
				);
			}
			throw signingError;
		}

		return NextResponse.json({
			attachmentId,
			attachmentName,
			uploadUrl: upload.url,
			uploadContentType: contentType,
			uploadHeaders: upload.requiredHeaders,
		});
	} catch (err) {
		if (err instanceof FormAttachmentWriteRejectedError) {
			return handleApiError(new ApiError(err.message, 409));
		}
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Attachment initiate failed", 500),
		);
	}
}
