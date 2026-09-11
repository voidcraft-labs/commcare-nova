import { describe, expect, it } from "vitest";
import { prepareDesignContinuation } from "../designContinuationRecovery";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("design_continuation_recovery_");

async function seed() {
	const id = await h.seedDesignSession({
		owner_user_id: "recovery-owner",
		project_id: "recovery-project",
	});
	const row = await h
		.db()
		.updateTable("design_sessions")
		.set({ last_error_type: "design-terminal-omission" })
		.where("id", "=", id)
		.returningAll()
		.executeTakeFirstOrThrow();
	return {
		designSessionId: id,
		actorUserId: "recovery-owner",
		expectedUpdatedAt: row.updated_at.toISOString(),
		execute: true,
	};
}

describe("operator design continuation preparation", () => {
	it("records an idempotent receipt without clearing errors, artifacts, or billing", async () => {
		const args = await seed();
		const before = await h
			.db()
			.selectFrom("design_sessions")
			.selectAll()
			.where("id", "=", args.designSessionId)
			.executeTakeFirstOrThrow();
		await prepareDesignContinuation({ ...args, execute: false });
		expect(
			(
				await h
					.db()
					.selectFrom("design_sessions")
					.selectAll()
					.where("id", "=", args.designSessionId)
					.executeTakeFirstOrThrow()
			).continuation_recovery,
		).toBeNull();
		const prepared = await prepareDesignContinuation(args);
		expect((await prepareDesignContinuation(args)).deduplicated).toBe(true);
		const after = await h
			.db()
			.selectFrom("design_sessions")
			.selectAll()
			.where("id", "=", args.designSessionId)
			.executeTakeFirstOrThrow();
		expect(after).toEqual({
			...before,
			continuation_recovery: prepared.receipt,
			updated_at: new Date(prepared.receipt.preparedAt),
		});
	});
	it("refuses a design changed since the scan", async () => {
		const args = await seed();
		await h
			.db()
			.updateTable("design_sessions")
			.set({ updated_at: new Date(Date.parse(args.expectedUpdatedAt) + 1000) })
			.where("id", "=", args.designSessionId)
			.execute();
		await expect(prepareDesignContinuation(args)).rejects.toThrow(
			"changed after inspection",
		);
	});
	it("requires the owner and current Project edit membership", async () => {
		const args = await seed();
		await expect(
			prepareDesignContinuation({ ...args, actorUserId: "someone-else" }),
		).rejects.toThrow("owner");
		await h
			.pool()
			.query('DELETE FROM auth_member WHERE "userId" = $1', [args.actorUserId]);
		await expect(prepareDesignContinuation(args)).rejects.toThrow(
			"edit access",
		);
	});
});
