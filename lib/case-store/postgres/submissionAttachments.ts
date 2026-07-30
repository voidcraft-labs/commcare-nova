import type { Transaction } from "kysely";
import { preparePendingFormAttachments } from "@/lib/db/formAttachmentPreparation";
import {
	beginFormAttachmentPreparation,
	FormAttachmentWriteRejectedError,
	formAttachmentsArePrepared,
} from "@/lib/db/formAttachments";
import {
	captureContentType,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	captureObjectKeyFor,
	MAX_SUBMITTED_CAPTURE_BYTES,
	MAX_SUBMITTED_CAPTURE_COUNT,
} from "@/lib/domain/captureFormats";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import { CaptureSubmissionRejectedError } from "../errors";
import type { Database } from "../sql/database";
import type { ApplySubmissionArgs } from "../submission";

function reject(message: string): never {
	throw new CaptureSubmissionRejectedError(message);
}

type CaptureIntent = NonNullable<ApplySubmissionArgs["captureIntent"]>;
type CommittedCaptureDescriptor = CaptureIntent["allowedAttachments"][number];

/**
 * Copy and verify every selected immutable generation before case acceptance.
 *
 * The DB-first `preparing` transition necessarily precedes the deterministic
 * final-key copy, so a request crash always leaves scheduled maintenance a
 * recovery row. This function never accepts a case effect; the later atomic
 * envelope transaction independently re-proves `prepared` and consumes it.
 */
export async function prepareCaptureSubmissionBytes(args: {
	appId: string;
	projectId: string;
	actorUserId: string;
	intent: CaptureIntent;
}): Promise<void> {
	let begun: Awaited<ReturnType<typeof beginFormAttachmentPreparation>>;
	try {
		begun = await beginFormAttachmentPreparation({
			appId: args.appId,
			projectId: args.projectId,
			actorUserId: args.actorUserId,
			entryKey: args.intent.entryKey,
			formUuid: args.intent.formUuid,
			requestDigest: args.intent.requestDigest,
			attachments: args.intent.attachments,
		});
	} catch (error) {
		if (error instanceof FormAttachmentWriteRejectedError) {
			reject(error.message);
		}
		throw error;
	}
	if (begun.kind === "replay") return;
	await preparePendingFormAttachments({
		appId: args.appId,
		projectId: args.projectId,
		actorUserId: args.actorUserId,
		entryKey: args.intent.entryKey,
		attachmentIds: begun.attachmentIds,
		limit: begun.attachmentIds.length,
	});
	const ready = await formAttachmentsArePrepared({
		appId: args.appId,
		projectId: args.projectId,
		actorUserId: args.actorUserId,
		entryKey: args.intent.entryKey,
		attachmentIds: begun.attachmentIds,
	});
	if (!ready) {
		reject(
			"An attachment could not be made durable before submission. Check your connection and try Submit again.",
		);
	}
}

/**
 * Re-prove immutable staged-row metadata against the capture kind in the
 * exact committed snapshot that admitted this submission.
 *
 * Confirm and submit are deliberately separate transactions. A peer can
 * keep a field UUID/path stable while changing image → audio between them,
 * so UUID/path alone is not terminal authority over the already-uploaded
 * bytes.
 */
export function captureRowMatchesCommittedDescriptor(
	row: {
		readonly originalFilename: string;
		readonly extension: string;
		readonly contentType: string;
	},
	descriptor: Pick<
		CommittedCaptureDescriptor,
		"captureKind" | "acceptedFormats"
	>,
): boolean {
	const committedExtension = captureExtensionFor(
		descriptor.captureKind,
		row.originalFilename,
	);
	return (
		committedExtension === row.extension &&
		captureContentType(row.extension) === row.contentType &&
		descriptor.acceptedFormats.some(
			(format) =>
				format.extension === row.extension &&
				format.contentType === row.contentType,
		)
	);
}

/**
 * Reserve exactly the named prepared rows for a new receipt claim.
 *
 * The generic receipt lifecycle owns entry serialization, replay
 * adjudication, sequence fencing, receipt insertion, and completion. This
 * attachment-only participant validates and transitions rows inside that same
 * transaction.
 */
export async function reserveCaptureSubmission(
	trx: Transaction<Database>,
	args: {
		appId: string;
		projectId: string;
		actorUserId: string;
		intent: CaptureIntent;
	},
): Promise<void> {
	const app = await trx
		.selectFrom("apps")
		.select(["mutation_seq", "project_id"])
		.where("id", "=", args.appId)
		.executeTakeFirst();
	if (
		app?.project_id !== args.projectId ||
		safePersistedSequence(
			app.mutation_seq,
			`apps.mutation_seq for app ${args.appId}`,
		) !== args.intent.expectedAppMutationSeq
	) {
		reject(
			"The form changed while it was being submitted. Reload the running app and try again.",
		);
	}

	const attachments = args.intent.attachments;
	const names = attachments.map((attachment) => attachment.attachmentName);
	const answerSlots = attachments.map((attachment) =>
		JSON.stringify([attachment.fieldUuid, attachment.instancePath]),
	);
	if (
		attachments.length > MAX_SUBMITTED_CAPTURE_COUNT ||
		new Set(names).size !== names.length ||
		new Set(answerSlots).size !== answerSlots.length
	) {
		reject(
			`A form submission may carry at most ${MAX_SUBMITTED_CAPTURE_COUNT} distinct attachment answers.`,
		);
	}

	const rows = await trx
		.selectFrom("form_attachments")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.intent.entryKey)
		.forUpdate()
		.execute();

	const allowed = new Map(
		args.intent.allowedAttachments.map((entry) => [entry.fieldUuid, entry]),
	);
	const byName = new Map(rows.map((row) => [row.attachment_name, row]));
	const now = new Date();
	const selected = attachments.map((attachment) => {
		const row = byName.get(attachment.attachmentName);
		if (
			row === undefined ||
			row.status !== "prepared" ||
			row.prepared_generation === null ||
			row.expires_at <= now
		) {
			reject(
				"An attachment named by this form is no longer durably prepared for this entry. Attach it again.",
			);
		}
		const descriptor = allowed.get(attachment.fieldUuid);
		if (
			descriptor === undefined ||
			row.field_uuid !== attachment.fieldUuid ||
			row.instance_path !== attachment.instancePath ||
			!captureInstancePathMatchesTemplate(
				attachment.instancePath,
				descriptor.instancePathTemplate,
			) ||
			!captureRowMatchesCommittedDescriptor(
				{
					originalFilename: row.original_filename,
					extension: row.extension,
					contentType: row.content_type,
				},
				descriptor,
			)
		) {
			reject(
				"An attachment does not belong to a capture question in the committed form. Reload and attach it again.",
			);
		}
		return row;
	});
	const totalBytes = selected.reduce(
		(total, row) => total + Number(row.size_bytes),
		0,
	);
	if (totalBytes > MAX_SUBMITTED_CAPTURE_BYTES) {
		reject(
			`This form's attachments exceed the ${MAX_SUBMITTED_CAPTURE_BYTES} byte submission limit.`,
		);
	}

	if (selected.length > 0) {
		for (const row of selected) {
			const updated = await trx
				.updateTable("form_attachments")
				.set({
					status: "submitted",
					submitted_at: now,
					gcs_object_key: captureObjectKeyFor(
						row.project_id,
						row.attachment_id,
						row.extension,
					),
					object_generation: row.prepared_generation,
					prepared_generation: null,
					next_preparation_at: null,
					last_preparation_error: null,
				})
				.where("attachment_id", "=", row.attachment_id)
				.where("status", "=", "prepared")
				.where("prepared_generation", "=", row.prepared_generation)
				.returning("attachment_id")
				.executeTakeFirst();
			if (updated === undefined) {
				throw new Error(
					"A prepared attachment changed during atomic submission.",
				);
			}
		}
	}
}
