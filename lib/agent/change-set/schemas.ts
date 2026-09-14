/**
 * Strict persisted-JSON schemas for the change-set tables.
 *
 * Producer and reader share these exact schemas: every JSONB payload a
 * change-set row carries (`receipt`) is written from a value these schemas accepted and
 * read back through `parsePersistedJsonText` + the same schema, unknown keys
 * failing closed. Mutation bytes are NOT here — a step's `mutations` column
 * goes through `parsePersistedMutationBatchText` (the one mutation-admission
 * boundary) like every other durable batch.
 */

import { z } from "zod";

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);

/** Compact stable finding fingerprint — a 16-hex prefix of the canonical
 *  finding digest (identity for introduced/resolved comparison, not a
 *  cryptographic commitment). */
const findingFingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/);

/**
 * The compact diagnostics summary a stage receipt persists — stable finding
 * fingerprints and counts, never full findings (inspect recomputes current
 * details from the rehydrated overlay).
 */
export const changeSetDiagnosticsSummarySchema = z
	.object({
		candidateDigest: sha256HexSchema,
		findingCount: z.number().int().nonnegative(),
		findingFingerprints: z.array(findingFingerprintSchema),
		canCommit: z.boolean(),
	})
	.strict();

/** Persist the semantic answer with the write. Mutation bytes live in its step. */
export const mutationReplayResultSchema = z
	.object({
		kind: z.literal("mutate"),
		mutations: z.tuple([]),
		result: z.record(z.string(), z.json()),
	})
	.strict();
export type MutationReplayResult = z.infer<typeof mutationReplayResultSchema>;
export type ChangeSetDiagnosticsSummary = z.infer<
	typeof changeSetDiagnosticsSummarySchema
>;

const stageErrorCodeSchema = z.enum([
	"WIRE_CANONICALITY_INVALID",
	"IDENTITY_COLLISION",
	"SEQUENCE_ANCHOR_INVALID",
	"TARGET_INVALID",
	"RENAME_PLAN_INVALID",
	"REDUCER_FAILURE",
	"TOOL_INPUT_INVALID",
	"TOOL_NOT_ALLOWED",
	"EXCLUSIVE_NOT_ALONE",
	"EXCLUSIVE_SET_CLOSED",
]);

/**
 * The closed durable receipt one staging request records in its append-only
 * ledger — beside the step when staged, or beside the unchanged workspace
 * when accepted as a final no-op or rejected. An idempotent retry replays it
 * verbatim. Only safe structured facts: no raw mutations (the step row holds
 * those) and no secrets. A no-op may retain one exact typed tool result when
 * its typed contents control whether execution may continue.
 */
export const stageRequestReceiptSchema = z
	.object({
		requestId: z.string().min(1),
		disposition: z.enum(["staged", "noop", "rejected"]),
		/** The workspace revision AFTER this request (staged: expected + 1;
		 * no-op or rejected: unchanged). */
		workspaceRevision: z.number().int().nonnegative(),
		/** The appended step's ordinal — staged dispositions only. */
		ordinal: z.number().int().nonnegative().optional(),
		/** Canonical digest of the appended admitted batch — staged only. */
		mutationDigest: sha256HexSchema.optional(),
		diagnostics: changeSetDiagnosticsSummarySchema.optional(),
		replayResult: mutationReplayResultSchema.optional(),
		error: z
			.object({
				code: stageErrorCodeSchema,
				message: z.string().min(1),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((receipt, ctx) => {
		if (
			receipt.disposition !== "rejected" &&
			receipt.replayResult === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: ["replayResult"],
				message: "An accepted request must retain its tool result.",
			});
		}
		if (receipt.disposition === "staged") {
			if (receipt.ordinal === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["ordinal"],
					message: "A staged receipt must name its step ordinal.",
				});
			}
			if (receipt.mutationDigest === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["mutationDigest"],
					message: "A staged receipt must carry its mutation digest.",
				});
			}
			if (receipt.error !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["error"],
					message: "A staged receipt cannot carry a rejection.",
				});
			}
		} else if (receipt.disposition === "noop") {
			if (
				receipt.ordinal !== undefined ||
				receipt.mutationDigest !== undefined ||
				receipt.error !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["ordinal"],
					message: "An accepted no-op receipt appends no mutation step.",
				});
			}
		} else {
			if (receipt.error === undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["error"],
					message: "A rejected receipt must carry its rejection.",
				});
			}
			if (
				receipt.ordinal !== undefined ||
				receipt.mutationDigest !== undefined ||
				receipt.replayResult !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["ordinal"],
					message: "A rejected receipt appends no step.",
				});
			}
		}
	});
export type StageRequestReceipt = z.infer<typeof stageRequestReceiptSchema>;
