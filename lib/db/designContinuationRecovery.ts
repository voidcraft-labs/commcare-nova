/** Operator preparation only. A later user turn owns any chargeable work. */
import { z } from "zod";
import { lockActorGenerationGate } from "./actorGenerationGate";
import { assertProjectCapabilityInTransaction } from "./canonicalCommitKernel";
import { getAppDb, withAppTx } from "./pg";

export const DESIGN_CONTINUATION_RECOVERY_VERSION = 1;
const failureTypes = [
	"design-terminal-omission",
	"design-step-budget",
	"design-submission-nonconvergent",
];
const receiptSchema = z
	.object({
		version: z.literal(DESIGN_CONTINUATION_RECOVERY_VERSION),
		expectedUpdatedAt: z.string(),
		actorUserId: z.string(),
		previousErrorType: z.string(),
		preparedAt: z.string(),
	})
	.strict();

export async function scanDesignContinuations() {
	return (await getAppDb())
		.selectFrom("design_sessions")
		.select([
			"id",
			"project_id",
			"owner_user_id",
			"last_error_type",
			"updated_at",
			"run_id",
			"run_holder_nonce",
			"res_run_id",
			"active_design_revision_id",
			"active_build_plan_id",
			"continuation_recovery",
		])
		.where("mode", "=", "build")
		.where("state", "=", "active")
		.where("app_id", "is", null)
		.where("last_error_type", "in", failureTypes)
		.orderBy("updated_at")
		.execute();
}

export async function prepareDesignContinuation(args: {
	readonly designSessionId: string;
	readonly actorUserId: string;
	readonly expectedUpdatedAt: string;
	readonly execute: boolean;
}) {
	const expected = z.iso
		.datetime({ offset: true })
		.parse(args.expectedUpdatedAt);
	return withAppTx(async (tx) => {
		await lockActorGenerationGate(tx, args.actorUserId);
		const session = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("id", "=", args.designSessionId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		if (session.owner_user_id !== args.actorUserId)
			throw new Error("Recovery must name the design's owner.");
		await assertProjectCapabilityInTransaction(
			tx,
			args.actorUserId,
			session.project_id,
			"edit",
			"The design owner no longer has edit access to this Project.",
		);
		if (
			session.mode !== "build" ||
			session.state !== "active" ||
			session.app_id !== null ||
			session.active_build_plan_id !== null
		)
			throw new Error(
				"Only a pre-app design without a build plan can be prepared.",
			);
		if (
			session.run_id !== null ||
			session.run_holder_nonce !== null ||
			session.res_run_id !== null
		)
			throw new Error(
				"The design still has run authority or a reservation. Finish or reap it before recovery.",
			);
		if (session.continuation_recovery !== null) {
			const receipt = receiptSchema.parse(session.continuation_recovery);
			if (
				receipt.expectedUpdatedAt === expected &&
				receipt.actorUserId === args.actorUserId &&
				session.updated_at.toISOString() === receipt.preparedAt
			)
				return { deduplicated: true, receipt };
		}
		if (session.updated_at.toISOString() !== new Date(expected).toISOString())
			throw new Error(
				"The design changed after inspection. Scan it again before recovery.",
			);
		if (
			session.last_error_type === null ||
			!failureTypes.includes(session.last_error_type)
		)
			throw new Error(
				"This design did not stop with a supported continuation failure.",
			);
		const preparedAt = new Date();
		const receipt = receiptSchema.parse({
			version: DESIGN_CONTINUATION_RECOVERY_VERSION,
			expectedUpdatedAt: expected,
			actorUserId: args.actorUserId,
			previousErrorType: session.last_error_type,
			preparedAt: preparedAt.toISOString(),
		});
		if (args.execute)
			await tx
				.updateTable("design_sessions")
				.set({
					continuation_recovery: JSON.stringify(receipt),
					updated_at: preparedAt,
				})
				.where("id", "=", session.id)
				.executeTakeFirstOrThrow();
		return { deduplicated: false, receipt };
	});
}
