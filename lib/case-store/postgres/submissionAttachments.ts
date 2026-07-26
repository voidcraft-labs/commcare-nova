import { sql, type Transaction } from "kysely";
import { lockFormAttachmentEntry } from "@/lib/db/formAttachmentLocks";
import {
	captureInstancePathMatchesTemplate,
	MAX_SUBMITTED_CAPTURE_BYTES,
	MAX_SUBMITTED_CAPTURE_COUNT,
} from "@/lib/domain/captureFormats";
import { CaptureSubmissionRejectedError } from "../errors";
import type { Database } from "../sql/database";
import type {
	ApplySubmissionArgs,
	SubmissionEnvelopeResult,
} from "../submission";

function reject(message: string): never {
	throw new CaptureSubmissionRejectedError(message);
}

function storedResult(value: unknown): SubmissionEnvelopeResult {
	const parsed =
		typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as { childCaseIds?: unknown }).childCaseIds) ||
		!Array.isArray((parsed as { operations?: unknown }).operations)
	) {
		throw new Error(
			"A committed form submission replay row contains an invalid result.",
		);
	}
	return parsed as SubmissionEnvelopeResult;
}

type CaptureIntent = NonNullable<ApplySubmissionArgs["captureIntent"]>;

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
	await lockFormAttachmentEntry(trx, {
		appId: args.appId,
		actorUserId: args.actorUserId,
		entryKey: args.intent.entryKey,
	});

	const prior = await trx
		.selectFrom("form_submission_intents")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.intent.entryKey)
		.forUpdate()
		.executeTakeFirst();
	if (prior !== undefined) {
		if (
			prior.request_digest !== args.intent.requestDigest ||
			prior.form_uuid !== args.intent.formUuid
		) {
			reject(
				"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
			);
		}
		if (prior.result === null) {
			throw new Error(
				"A committed form submission intent is missing its atomic result.",
			);
		}
		return storedResult(prior.result);
	}

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
		if (row === undefined || row.status !== "staged" || row.expires_at <= now) {
			reject(
				"An attachment named by this form is no longer staged for this entry. Attach it again.",
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
		await trx
			.updateTable("form_attachments")
			.set({
				status: "promotion_pending",
				next_promotion_at: sql<Date>`now()`,
				last_promotion_error: null,
			})
			.where(
				"attachment_id",
				"in",
				selected.map((row) => row.attachment_id),
			)
			.where("status", "=", "staged")
			.execute();
	}
	return undefined;
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
