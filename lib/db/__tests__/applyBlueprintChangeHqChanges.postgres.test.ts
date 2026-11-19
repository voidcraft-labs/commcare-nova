/**
 * A bring-in of changes made in CommCare HQ, committed through
 * `applyBlueprintChange` and the real canonical kernel on real Postgres, as
 * one `hq-changes` change at the head its plan was computed at, with the
 * caller's own transaction work.
 *
 * The plausible failures: a commit at a head that moved since the plan was
 * computed (the batch would land over edits no one reviewed); the caller's
 * work run outside the commit's transaction, run twice, run with another
 * sequence, or kept when the commit rolls back; a retried request of the same
 * batch refused as a moved head instead of answering its commit; and an
 * editor's batch allowed to commit at an expected head or with transaction
 * work, or a bring-in allowed without its head, any of which would reach the
 * database before being refused; and a caller the app has left, or who lost
 * edit, told the head moved (which sends it to read who moved it) or that a
 * batch id exists, before the kernel has authorized it.
 */

import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import {
	AppHeadMovedError,
	AppProjectChangedError,
	CommitReauthError,
} from "../commitGuard";
import type { AppDatabase } from "../pg";
import {
	type ApplyBlueprintChangeProposalArgs,
	applyBlueprintChangeProposal,
} from "./admittedWriterTestHelpers";
import { setupAppStateTestDb } from "./appStateTestDb";
import { heldPlacementApp } from "./heldPlacementApp";

const MEMBER = "hq-changes-member";
const PROJECT = "hq-changes-project";

const h = setupAppStateTestDb("apply_hq_changes_");

const REFUSAL = (kind: string) =>
	`Only a bring-in of changes made in CommCare HQ commits at an expected head with its own transaction work. This call asked for that under the kind ${kind}; an editor's batch takes neither.`;

async function seed(): Promise<{ appId: string; head: number }> {
	const appId = await h.seedAppWithBlueprint(heldPlacementApp().doc, {
		owner: MEMBER,
		projectId: PROJECT,
	});
	return { appId, head: await headOf(appId) };
}

async function headOf(appId: string): Promise<number> {
	const row = await h
		.db()
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	return Number(row.mutation_seq);
}

async function changeRows(appId: string, afterSeq: number) {
	const rows = await h
		.db()
		.selectFrom("app_changes")
		.select(["seq", "batch_id", "run_id", "actor_id", "kind"])
		.select(sql<string>`mutations::text`.as("mutationsText"))
		.where("app_id", "=", appId)
		.where("seq", ">", afterSeq)
		.orderBy("seq")
		.execute();
	return rows.map((row) => ({
		...row,
		seq: Number(row.seq),
		mutations: JSON.parse(row.mutationsText),
		mutationsText: undefined,
	}));
}

async function appName(appId: string): Promise<string> {
	const row = await h
		.db()
		.selectFrom("apps")
		.select("app_name")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	return row.app_name;
}

/** A table the caller's transaction work writes, so a test can see whether
 *  that write committed. */
async function createProbe(): Promise<void> {
	await sql`CREATE TABLE hq_changes_probe (app_id text NOT NULL, seq bigint NOT NULL)`.execute(
		h.db(),
	);
}

async function probeRows(appId: string): Promise<number[]> {
	const rows = await sql<{ seq: string }>`
		SELECT seq::text AS seq FROM hq_changes_probe WHERE app_id = ${appId} ORDER BY seq
	`.execute(h.db());
	return rows.rows.map((row) => Number(row.seq));
}

/** Records each call, and writes the sequence it was handed into the probe
 *  table on the transaction it was handed. */
function recordingWork(appId: string) {
	const calls: { seq: number; headInTransaction: number }[] = [];
	const inTransaction = async ({
		tx,
		seq,
	}: {
		readonly tx: Transaction<AppDatabase>;
		readonly seq: number;
	}) => {
		const head = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		calls.push({ seq, headInTransaction: Number(head.mutation_seq) });
		await sql`INSERT INTO hq_changes_probe (app_id, seq) VALUES (${appId}, ${seq})`.execute(
			tx,
		);
	};
	return { calls, inTransaction };
}

function bringIn(
	appId: string,
	overrides: Partial<ApplyBlueprintChangeProposalArgs> & {
		readonly name: string;
	},
) {
	const { name, ...rest } = overrides;
	return applyBlueprintChangeProposal({
		appId,
		userId: MEMBER,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "hq-changes",
		guard: { mutations: [{ kind: "setAppName", name }] },
		...rest,
	});
}

function autosave(appId: string, name: string) {
	return applyBlueprintChangeProposal({
		appId,
		userId: MEMBER,
		expectedProjectId: PROJECT,
		batchId: crypto.randomUUID(),
		kind: "autosave",
		guard: { mutations: [{ kind: "setAppName", name }] },
	});
}

describe("applyBlueprintChange with hq-changes", () => {
	it("refuses a caller the app has left, or who lost edit, before telling it the head moved", async () => {
		const { appId, head: reviewedAt } = await seed();
		await autosave(appId, "Edited in Nova");
		/* Admitted against the Project the app was in before it moved. */
		await expect(
			bringIn(appId, {
				name: "From CommCare HQ",
				expectedProjectId: "the-project-it-left",
				expectedHeadSeq: reviewedAt,
			}),
		).rejects.toBeInstanceOf(AppProjectChangedError);
		/* Still in the Project, no longer an editor of it. */
		await sql`
			UPDATE auth_member SET role = 'viewer'
			WHERE "userId" = ${MEMBER} AND "organizationId" = ${PROJECT}
		`.execute(h.db());
		const demoted = bringIn(appId, {
			name: "From CommCare HQ",
			expectedHeadSeq: reviewedAt,
		});
		await expect(demoted).rejects.toBeInstanceOf(CommitReauthError);
		await expect(demoted).rejects.not.toBeInstanceOf(AppHeadMovedError);
	});

	it("commits only at expectedHeadSeq, as one hq-changes row with the member and no run", async () => {
		await createProbe();
		const { appId, head: reviewedAt } = await seed();
		await autosave(appId, "Edited in Nova");
		const moved = await headOf(appId);
		const work = recordingWork(appId);

		const stale = bringIn(appId, {
			name: "From CommCare HQ",
			expectedHeadSeq: reviewedAt,
			inTransaction: work.inTransaction,
		});
		await expect(stale).rejects.toBeInstanceOf(AppHeadMovedError);
		await expect(stale).rejects.toMatchObject({
			expectedSeq: reviewedAt,
			headSeq: moved,
		});
		expect(work.calls).toEqual([]);
		expect(await headOf(appId)).toBe(moved);
		expect(await changeRows(appId, moved)).toEqual([]);
		expect(await appName(appId)).toBe("Edited in Nova");

		const batchId = crypto.randomUUID();
		const committed = await bringIn(appId, {
			name: "From CommCare HQ",
			batchId,
			expectedHeadSeq: moved,
			inTransaction: work.inTransaction,
		});
		expect(committed.seq).toBe(moved + 1);
		expect(committed.committedDoc.appName).toBe("From CommCare HQ");
		expect(await headOf(appId)).toBe(moved + 1);
		expect(await changeRows(appId, moved)).toEqual([
			{
				seq: moved + 1,
				batch_id: batchId,
				run_id: null,
				actor_id: MEMBER,
				kind: "hq-changes",
				mutations: [{ kind: "setAppName", name: "From CommCare HQ" }],
				mutationsText: undefined,
			},
		]);
	});

	it("runs inTransaction once, in the commit's transaction with the sequence it takes, and a retry of the batch answers the commit without running it again", async () => {
		await createProbe();
		const { appId, head } = await seed();
		const work = recordingWork(appId);
		const batchId = crypto.randomUUID();

		const committed = await bringIn(appId, {
			name: "From CommCare HQ",
			batchId,
			expectedHeadSeq: head,
			inTransaction: work.inTransaction,
		});
		expect(committed.seq).toBe(head + 1);
		expect(work.calls).toEqual([{ seq: head + 1, headInTransaction: head }]);
		expect(await probeRows(appId)).toEqual([head + 1]);

		// The head has moved past the plan's, and the same batch still answers
		// the commit it made: a double press, or a retried lost response.
		await autosave(appId, "Edited after");
		const repeat = await bringIn(appId, {
			name: "From CommCare HQ",
			batchId,
			expectedHeadSeq: head,
			inTransaction: work.inTransaction,
		});
		expect(repeat.seq).toBe(head + 1);
		expect(work.calls).toHaveLength(1);
		expect(await probeRows(appId)).toEqual([head + 1]);
		expect((await changeRows(appId, head)).map((row) => row.kind)).toEqual([
			"hq-changes",
			"autosave",
		]);
	});

	it("rolls inTransaction's writes back with a commit that fails after it, and a commit with its own failure", async () => {
		await createProbe();
		const { appId, head } = await seed();
		await sql`
			CREATE FUNCTION hq_changes_refuse_batch() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				IF NEW.batch_id = 'refused-batch' THEN
					RAISE EXCEPTION 'the change log refused this batch';
				END IF;
				RETURN NEW;
			END
			$$
		`.execute(h.db());
		await sql`
			CREATE TRIGGER hq_changes_refuse_batch BEFORE INSERT ON app_changes
			FOR EACH ROW EXECUTE FUNCTION hq_changes_refuse_batch()
		`.execute(h.db());
		const work = recordingWork(appId);

		await expect(
			bringIn(appId, {
				name: "From CommCare HQ",
				batchId: "refused-batch",
				expectedHeadSeq: head,
				inTransaction: work.inTransaction,
			}),
		).rejects.toThrow("the change log refused this batch");
		expect(work.calls.map((call) => call.seq)).toEqual([head + 1]);

		await expect(
			bringIn(appId, {
				name: "From CommCare HQ",
				expectedHeadSeq: head,
				inTransaction: async (context) => {
					await work.inTransaction(context);
					throw new Error("the record could not be written");
				},
			}),
		).rejects.toThrow("the record could not be written");
		expect(work.calls.map((call) => call.seq)).toEqual([head + 1, head + 1]);

		expect(await probeRows(appId)).toEqual([]);
		expect(await headOf(appId)).toBe(head);
		expect(await changeRows(appId, head)).toEqual([]);
		expect(await appName(appId)).toBe("Held placements");
	});

	it("writes Project data once, on the commit's transaction before its record, rolls it back with the commit, and skips it on a retried batch", async () => {
		await createProbe();
		const { appId, head } = await seed();
		const order: string[] = [];
		const projectDataWrite = async ({
			tx,
			projectId,
		}: {
			readonly tx: Transaction<AppDatabase>;
			readonly projectId: string;
		}) => {
			order.push(`project-data:${projectId}`);
			/* The app row is this transaction's: the head test has passed, and the
			 * row is locked for the commit. */
			const row = await tx
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
			await sql`INSERT INTO hq_changes_probe (app_id, seq) VALUES (${appId}, ${-Number(row.mutation_seq)})`.execute(
				tx,
			);
		};
		const work = recordingWork(appId);
		const inTransaction = async (context: {
			readonly tx: Transaction<AppDatabase>;
			readonly seq: number;
		}) => {
			order.push("record");
			await work.inTransaction(context);
		};

		/* Turned back after the Project data was written: none of it stays. */
		await expect(
			bringIn(appId, {
				name: "From CommCare HQ",
				expectedHeadSeq: head,
				projectDataWrite,
				inTransaction: async (context) => {
					await inTransaction(context);
					throw new Error("the record could not be written");
				},
			}),
		).rejects.toThrow("the record could not be written");
		expect(order).toEqual([`project-data:${PROJECT}`, "record"]);
		expect(await probeRows(appId)).toEqual([]);

		/* A moved head writes no Project data at all. */
		await autosave(appId, "Edited in Nova");
		order.length = 0;
		await expect(
			bringIn(appId, {
				name: "From CommCare HQ",
				expectedHeadSeq: head,
				projectDataWrite,
				inTransaction,
			}),
		).rejects.toBeInstanceOf(AppHeadMovedError);
		expect(order).toEqual([]);

		const moved = await headOf(appId);
		const batchId = crypto.randomUUID();
		const committed = await bringIn(appId, {
			name: "From CommCare HQ",
			batchId,
			expectedHeadSeq: moved,
			projectDataWrite,
			inTransaction,
		});
		expect(order).toEqual([`project-data:${PROJECT}`, "record"]);
		expect(await probeRows(appId)).toEqual([-moved, committed.seq]);
		/* The same batch again answers its commit and writes nothing more. */
		await bringIn(appId, {
			name: "From CommCare HQ",
			batchId,
			expectedHeadSeq: moved,
			projectDataWrite,
			inTransaction,
		});
		expect(order).toHaveLength(2);
		expect(await probeRows(appId)).toEqual([-moved, committed.seq]);
	});

	it("refuses Project data under an editor's kind before any write", async () => {
		const { appId, head } = await seed();
		let ran = false;
		await expect(
			applyBlueprintChangeProposal({
				appId,
				userId: MEMBER,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				kind: "autosave",
				projectDataWrite: async () => {
					ran = true;
				},
				guard: { mutations: [{ kind: "setAppName", name: "Refused" }] },
			}),
		).rejects.toThrow(REFUSAL("autosave"));
		expect(ran).toBe(false);
		expect(await headOf(appId)).toBe(head);
	});

	it("refuses an expected head or transaction work under an editor's kind, and hq-changes with no head, before any write", async () => {
		const { appId, head } = await seed();
		let ran = false;
		const inTransaction = async () => {
			ran = true;
		};
		const editorCalls: ApplyBlueprintChangeProposalArgs[] = [
			{
				appId,
				userId: MEMBER,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				kind: "autosave",
				expectedHeadSeq: head,
				guard: { mutations: [{ kind: "setAppName", name: "Refused" }] },
			},
			{
				appId,
				userId: MEMBER,
				expectedProjectId: PROJECT,
				batchId: crypto.randomUUID(),
				kind: "mcp",
				runId: "run-1",
				inTransaction,
				guard: { mutations: [{ kind: "setAppName", name: "Refused" }] },
			},
		];
		for (const call of editorCalls) {
			await expect(applyBlueprintChangeProposal(call)).rejects.toThrow(
				REFUSAL(call.kind),
			);
		}
		await expect(
			bringIn(appId, { name: "Refused", inTransaction }),
		).rejects.toThrow(REFUSAL("hq-changes"));

		expect(ran).toBe(false);
		expect(await headOf(appId)).toBe(head);
		expect(await changeRows(appId, head)).toEqual([]);
		expect(await appName(appId)).toBe("Held placements");
	});
});
