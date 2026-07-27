import type { Transaction } from "kysely";
import { lockFormSubmissionEntry } from "@/lib/db/formAttachmentLocks";
import { CaptureSubmissionRejectedError } from "../errors";
import type { Database } from "../sql/database";
import type {
	ApplySubmissionArgs,
	SubmissionEnvelopeResult,
} from "../submission";
import { adjudicateSubmissionReceipt } from "../submission";
import { reserveCaptureSubmission } from "./submissionAttachments";

type SubmissionReceipt = ApplySubmissionArgs["submissionReceipt"];
type CaptureIntent = NonNullable<ApplySubmissionArgs["captureIntent"]>;

function reject(message: string): never {
	throw new CaptureSubmissionRejectedError(message);
}

function assertCaptureIntentIdentity(
	receipt: SubmissionReceipt,
	intent: CaptureIntent,
): void {
	if (
		intent.entryKey !== receipt.entryKey ||
		intent.formUuid !== receipt.formUuid ||
		intent.requestDigest !== receipt.requestDigest ||
		intent.expectedAppMutationSeq !== receipt.expectedAppMutationSeq
	) {
		reject(
			"The attachment reservation does not belong to this form submission. Reload the running app and try again.",
		);
	}
}

/**
 * Claim one form-entry receipt before any case effect.
 *
 * The entry advisory lock serializes exact retries, changed-digest collisions,
 * and two first requests that race on the same client-minted key. A prior
 * completed row replays without consulting current topology. A new row is
 * inserted in the caller's transaction and therefore rolls back with every
 * attachment transition and case effect.
 */
export async function prepareSubmissionReceipt(
	trx: Transaction<Database>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly actorUserId: string;
		readonly receipt: SubmissionReceipt;
		readonly captureIntent?: CaptureIntent;
		/**
		 * The mutation sequence returned by the production authorization fence
		 * from the same app-row lock held by this transaction. Direct package
		 * tests omit the production callback; capture reservations retain their
		 * independent app-row fence.
		 */
		readonly authorizedAppMutationSeq?: number;
	},
): Promise<SubmissionEnvelopeResult | undefined> {
	await lockFormSubmissionEntry(trx, {
		appId: args.appId,
		actorUserId: args.actorUserId,
		entryKey: args.receipt.entryKey,
	});

	const prior = await trx
		.selectFrom("form_submission_intents")
		.select(["form_uuid", "request_digest", "result"])
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
	if (verdict.kind === "mismatch") {
		reject(
			"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
		);
	}
	if (verdict.kind === "replay") return verdict.result;

	if (
		args.authorizedAppMutationSeq !== undefined &&
		args.authorizedAppMutationSeq !== args.receipt.expectedAppMutationSeq
	) {
		reject(
			"The form changed while it was being submitted. Reload the running app and try again.",
		);
	}

	if (args.captureIntent !== undefined) {
		assertCaptureIntentIdentity(args.receipt, args.captureIntent);
		await reserveCaptureSubmission(trx, {
			appId: args.appId,
			projectId: args.projectId,
			actorUserId: args.actorUserId,
			intent: args.captureIntent,
		});
	}

	await trx
		.insertInto("form_submission_intents")
		.values({
			app_id: args.appId,
			project_id: args.projectId,
			created_by: args.actorUserId,
			entry_key: args.receipt.entryKey,
			form_uuid: args.receipt.formUuid,
			app_mutation_seq: args.receipt.expectedAppMutationSeq,
			request_digest: args.receipt.requestDigest,
			result: null,
		})
		.execute();
	return undefined;
}

/** Complete the receipt in the same transaction as its case effects. */
export async function completeSubmissionReceipt(
	trx: Transaction<Database>,
	args: {
		readonly appId: string;
		readonly projectId: string;
		readonly actorUserId: string;
		readonly receipt: SubmissionReceipt;
		readonly result: SubmissionEnvelopeResult;
	},
): Promise<void> {
	const updated = await trx
		.updateTable("form_submission_intents")
		.set({ result: JSON.stringify(args.result) })
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.receipt.entryKey)
		.where("result", "is", null)
		.executeTakeFirst();
	if (Number(updated.numUpdatedRows) !== 1) {
		throw new Error(
			"The atomic form submission intent could not record its result.",
		);
	}
}
