/**
 * Strict persisted-JSON schemas for the change-set tables.
 *
 * Producer and reader share these exact schemas: every JSONB payload a
 * change-set row carries (`receipt`, `read_set`) is written from a value these schemas accepted and
 * read back through `parsePersistedJsonText` + the same schema, unknown keys
 * failing closed. Mutation bytes are NOT here — a step's `mutations` column
 * goes through `parsePersistedMutationBatchText` (the one mutation-admission
 * boundary) like every other durable batch.
 */

import { z } from "zod";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import { uuidSchema } from "@/lib/domain/uuid";

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);

/** Compact stable finding fingerprint — a 16-hex prefix of the canonical
 *  finding digest (identity for introduced/resolved comparison, not a
 *  cryptographic commitment). */
const findingFingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/);

/**
 * Change-set-local handle spelling: `@` plus a bounded lowercase slug. A
 * handle is a private compiler-local symbol — it never appears in Blueprint
 * state, app history, events, or any canonical surface.
 */
export const CHANGE_SET_HANDLE_PATTERN = /^@[a-z][a-z0-9_-]{0,63}$/;
export const changeSetHandleSchema = z
	.string()
	.regex(CHANGE_SET_HANDLE_PATTERN)
	.brand<"ChangeSetHandle">();
export type ChangeSetHandle = z.infer<typeof changeSetHandleSchema>;

/** The closed set of entity kinds a handle may bind. */
export const stagedEntityKindSchema = z.enum([
	"module",
	"form",
	"field",
	"option",
	"case_list_column",
	"search_input",
	"case_operation",
	"worker_property",
	"user_type",
	"persona",
	"organization_level",
	"location_property",
	"automation",
	"automation_criterion",
	"automation_setup_criterion",
	"automation_update",
	"automation_recipient",
	"automation_event",
	"automation_user_data_filter",
]);
export type StagedEntityKind = z.infer<typeof stagedEntityKindSchema>;

/**
 * Exact mutable non-Blueprint observations a staged step depends on. The
 * commit policy per kind: `organization` fences its exact revision;
 * `lookup-definition`/`lookup-column` re-resolve under the kernel's fresh
 * locked verdict; `media-asset` re-proves availability under the kernel's
 * media locks. Project scope is the row-level `base_project_id`, not a
 * per-step entry.
 */
export const externalReadDependencySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("organization"),
			projectId: z.string().min(1),
			revision: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("lookup-definition"),
			projectId: z.string().min(1),
			tableId: lookupTableIdSchema,
			definitionRevision: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("lookup-column"),
			projectId: z.string().min(1),
			tableId: lookupTableIdSchema,
			columnId: lookupColumnIdSchema,
			definitionRevision: z.string().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("media-asset"),
			projectId: z.string().min(1),
			assetId: mediaAssetIdSchema,
			metadataDigest: sha256HexSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("project-scope"),
			projectId: z.string().min(1),
		})
		.strict(),
]);
export type ExternalReadDependency = z.infer<
	typeof externalReadDependencySchema
>;

export const readSetSchema = z.array(externalReadDependencySchema);

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

/** Exact JSON tool envelope for a mutation-free result that controls whether
 * execution may continue. Most successful no-ops need only their compact
 * receipt, but a typed `needs_changes` result must survive process replacement
 * with its confirmation or repair details intact. */
export const nonAppliedMutationReplayResultSchema = z
	.json()
	.superRefine((value, ctx) => {
		if (value === null || Array.isArray(value) || typeof value !== "object") {
			ctx.addIssue({
				code: "custom",
				message: "A non-applied replay result must be a tool-result object.",
			});
			return;
		}
		const envelope = value as Record<string, unknown>;
		const result = envelope.result;
		if (
			envelope.kind !== "mutate" ||
			!Array.isArray(envelope.mutations) ||
			envelope.mutations.length !== 0 ||
			result === null ||
			Array.isArray(result) ||
			typeof result !== "object" ||
			(result as Record<string, unknown>).outcome !== "needs_changes"
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"A non-applied replay result must be a zero-mutation needs_changes envelope.",
			});
		}
	});
export type NonAppliedMutationReplayResult = z.infer<
	typeof nonAppliedMutationReplayResultSchema
>;
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
	"READ_SET_UNRECORDED",
	"HANDLE_RESOLUTION_FAILED",
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
		/** Handle bindings THIS request created (empty record when none). */
		handles: z.record(changeSetHandleSchema, uuidSchema),
		/** Canonical digest of the appended admitted batch — staged only. */
		mutationDigest: sha256HexSchema.optional(),
		diagnostics: changeSetDiagnosticsSummarySchema.optional(),
		/** Exact typed non-applied result when a generic no-op receipt would lose
		 * execution-control data. No-op dispositions only. */
		replayResult: nonAppliedMutationReplayResultSchema.optional(),
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
			if (receipt.replayResult !== undefined) {
				ctx.addIssue({
					code: "custom",
					path: ["replayResult"],
					message: "A staged receipt cannot carry a non-applied replay result.",
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
