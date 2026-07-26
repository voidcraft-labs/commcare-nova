import type { Transaction } from "kysely";
import { lockFormAttachmentEntry } from "@/lib/db/formAttachmentLocks";
import { preparePendingFormAttachments } from "@/lib/db/formAttachmentPreparation";
import {
	beginFormAttachmentPreparation,
	FormAttachmentWriteRejectedError,
	formAttachmentsArePrepared,
	readFormSubmissionReceipt,
} from "@/lib/db/formAttachments";
import {
	captureContentType,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	captureObjectKeyFor,
	MAX_SUBMITTED_CAPTURE_BYTES,
	MAX_SUBMITTED_CAPTURE_COUNT,
} from "@/lib/domain/captureFormats";
import { CaptureSubmissionRejectedError } from "../errors";
import type { Database } from "../sql/database";
import type {
	ApplySubmissionArgs,
	SubmissionEnvelopeResult,
} from "../submission";
import { adjudicateSubmissionReceipt } from "../submission";

function reject(message: string): never {
	throw new CaptureSubmissionRejectedError(message);
}

type CaptureIntent = NonNullable<ApplySubmissionArgs["captureIntent"]>;
type SubmissionReceipt = NonNullable<ApplySubmissionArgs["submissionReceipt"]>;
type CommittedCaptureDescriptor = CaptureIntent["allowedAttachments"][number];

/** Resolve an accepted receipt before reading today's form/capture structure.
 * Exact retries return the stored envelope; changed payloads reject under the
 * same entry identity. */
export async function readCaptureSubmissionReceipt(args: {
	appId: string;
	projectId: string;
	actorUserId: string;
	receipt: SubmissionReceipt;
}): Promise<SubmissionEnvelopeResult | undefined> {
	let prior: Awaited<ReturnType<typeof readFormSubmissionReceipt>>;
	try {
		prior = await readFormSubmissionReceipt({
			appId: args.appId,
			projectId: args.projectId,
			actorUserId: args.actorUserId,
			entryKey: args.receipt.entryKey,
		});
	} catch (error) {
		if (error instanceof FormAttachmentWriteRejectedError) {
			reject(error.message);
		}
		throw error;
	}
	const verdict = adjudicateSubmissionReceipt(args.receipt, prior);
	if (verdict.kind === "new") return undefined;
	if (verdict.kind === "mismatch") {
		reject(
			"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
		);
	}
	return verdict.result;
}

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
 * Claim the form entry before any case effect. A committed prior claim is an
 * idempotent replay; a fresh claim reserves exactly the named staged rows.
 */
export async function prepareCaptureSubmission(
	trx: Transaction<Database>,
	args: {
		appId: string;
		projectId: string;
		actorUserId: string;
		intent: CaptureIntent;
	},
): Promise<SubmissionEnvelopeResult | undefined> {
	const replay = await replayCaptureSubmission(trx, {
		appId: args.appId,
		projectId: args.projectId,
		actorUserId: args.actorUserId,
		receipt: args.intent,
	});
	if (replay !== undefined) return replay;

	const app = await trx
		.selectFrom("apps")
		.select(["mutation_seq", "project_id"])
		.where("id", "=", args.appId)
		.executeTakeFirst();
	if (
		app?.project_id !== args.projectId ||
		Number(app.mutation_seq) !== args.intent.expectedAppMutationSeq
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

	await trx
		.insertInto("form_submission_intents")
		.values({
			app_id: args.appId,
			project_id: args.projectId,
			created_by: args.actorUserId,
			entry_key: args.intent.entryKey,
			form_uuid: args.intent.formUuid,
			app_mutation_seq: args.intent.expectedAppMutationSeq,
			request_digest: args.intent.requestDigest,
			result: null,
		})
		.execute();
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
	return undefined;
}

/** Entry-locked replay check shared by capture-bearing and capture-removed
 * submissions. It must run before relationship/schema locks and every case
 * effect. */
export async function replayCaptureSubmission(
	trx: Transaction<Database>,
	args: {
		appId: string;
		projectId: string;
		actorUserId: string;
		receipt: SubmissionReceipt;
	},
): Promise<SubmissionEnvelopeResult | undefined> {
	await lockFormAttachmentEntry(trx, {
		appId: args.appId,
		actorUserId: args.actorUserId,
		entryKey: args.receipt.entryKey,
	});

	const prior = await trx
		.selectFrom("form_submission_intents")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.receipt.entryKey)
		.forUpdate()
		.executeTakeFirst();
	if (prior?.result === null) {
		throw new Error(
			"A committed form submission intent is missing its atomic result.",
		);
	}
	const verdict = adjudicateSubmissionReceipt(
		args.receipt,
		prior === undefined
			? undefined
			: {
					formUuid: prior.form_uuid,
					requestDigest: prior.request_digest,
					result: prior.result,
				},
	);
	if (verdict.kind === "new") return undefined;
	if (verdict.kind === "mismatch") {
		reject(
			"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
		);
	}
	return verdict.result;
}

/** Store the exact envelope result before the transaction can commit. */
export async function completeCaptureSubmission(
	trx: Transaction<Database>,
	args: {
		appId: string;
		projectId: string;
		actorUserId: string;
		intent: CaptureIntent;
		result: SubmissionEnvelopeResult;
	},
): Promise<void> {
	const updated = await trx
		.updateTable("form_submission_intents")
		.set({ result: JSON.stringify(args.result) })
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.intent.entryKey)
		.where("result", "is", null)
		.executeTakeFirst();
	if (Number(updated.numUpdatedRows) !== 1) {
		throw new Error(
			"The atomic form submission intent could not record its result.",
		);
	}
}
