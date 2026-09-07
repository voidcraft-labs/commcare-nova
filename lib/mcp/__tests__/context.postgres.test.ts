/** Real host persistence and event ordering, with every writer explicitly drained. */
import { expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch, loadApp } from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	admitMutationBatch,
	admitMutationStages,
} from "@/lib/doc/mutationAdmission";
import { proseText } from "@/lib/domain/prose";
import { readEvents } from "@/lib/log/reader";
import { initMcpCall } from "../context";
import { promptDoc } from "./promptFixtures";

const h = setupAppStateTestDb("mcp_context_", { authSchema: "migrated" });
const ACTOR = "editor";
const PROJECT = "project";
const RUN = "context-run";
async function seed() {
	const doc = promptDoc();
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: "author",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const call = initMcpCall(
		{ userId: ACTOR, scopes: ["nova.read", "nova.write"], authKind: "oauth" },
		doc.appId,
		PROJECT,
		"editor",
		RUN,
		undefined,
	);
	return { doc, ...call };
}
it("interleaves conversation and mutation envelopes, commits stages once and preserves their tags", async () => {
	const { doc, mcpCtx: ctx, logWriter } = await seed();
	try {
		const before = Date.now();
		const conversation = ctx.recordConversation({
			type: "assistant-text",
			text: "Preparing the app.",
		});
		const batch = admitMutationBatch([
			{ kind: "setAppName", name: "Named app" },
		]);
		const first = await ctx.recordMutations(
			prepareMutationCandidate(doc, batch),
			"name",
		);
		expect(first.seq).toBe(1);
		expect(first.committedDoc.appName).toBe("Named app");
		const stages = admitMutationStages([
			{
				stage: "first",
				mutations: [{ kind: "setAppName", name: "Intermediate" }],
			},
			{
				stage: "last",
				mutations: [{ kind: "setAppName", name: "Final name" }],
			},
		]);
		const second = await ctx.recordMutationStages(
			prepareMutationCandidate(first.committedDoc, stages.batch),
			stages,
		);
		expect(second.seq).toBe(2);
		expect(second.committedDoc.appName).toBe("Final name");
		await logWriter.flush();
		const logged = await readEvents(doc.appId, RUN);
		expect(logged).toEqual([
			{
				kind: "conversation",
				runId: RUN,
				ts: expect.any(Number),
				seq: 0,
				source: "mcp",
				payload: { type: "assistant-text", text: "Preparing the app." },
			},
			...[
				{ name: "Named app", stage: "name" },
				{ name: "Intermediate", stage: "first" },
				{ name: "Final name", stage: "last" },
			].map(({ name, stage }, index) => ({
				kind: "mutation",
				runId: RUN,
				ts: expect.any(Number),
				seq: index + 1,
				actor: "agent",
				source: "mcp",
				stage,
				mutation: { kind: "setAppName", name },
			})),
		]);
		expect([conversation, ...first.events, ...second.events]).toEqual(logged);
		for (const event of logged) {
			expect(event.ts).toBeGreaterThanOrEqual(before);
			expect(event.ts).toBeLessThanOrEqual(Date.now());
		}
		expect(
			await h
				.db()
				.selectFrom("app_changes")
				.select(["seq", "kind", "actor_id", "run_id", "mutations"])
				.orderBy("seq")
				.execute(),
		).toEqual([
			{
				seq: "1",
				kind: "mcp",
				actor_id: ACTOR,
				run_id: RUN,
				mutations: [{ kind: "setAppName", name: "Named app" }],
			},
			{
				seq: "2",
				kind: "mcp",
				actor_id: ACTOR,
				run_id: RUN,
				mutations: [
					{ kind: "setAppName", name: "Intermediate" },
					{ kind: "setAppName", name: "Final name" },
				],
			},
		]);
	} finally {
		await logWriter.flush();
	}
});
it("returns empty batches and empty stages without advancing durable history or creating log events", async () => {
	const { doc, mcpCtx: ctx, logWriter } = await seed();
	const before = await loadApp(doc.appId);
	try {
		const batch = admitMutationBatch([]);
		expect(
			await ctx.recordMutations(prepareMutationCandidate(doc, batch)),
		).toEqual({ events: [], committedDoc: doc });
		const stages = admitMutationStages([]);
		expect(
			await ctx.recordMutationStages(
				prepareMutationCandidate(doc, stages.batch),
				stages,
			),
		).toEqual({ events: [], committedDoc: doc });
		await logWriter.flush();
		expect(await loadApp(doc.appId)).toEqual(before);
		expect(await readEvents(doc.appId, RUN)).toEqual([]);
		expect(
			await h.db().selectFrom("app_changes").selectAll().execute(),
		).toEqual([]);
	} finally {
		await logWriter.flush();
	}
});
it("waits for the app lock and returns the authoritative document including a peer's accepted edit", async () => {
	const { doc, mcpCtx: ctx, logWriter } = await seed();
	try {
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const fieldUuid = doc.fieldOrder[formUuid][0];
		// The proposal is deliberately prepared from the older snapshot.
		const prepared = prepareMutationCandidate(
			doc,
			admitMutationBatch([
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { label: proseText("Full name") },
				},
			]),
		);
		await commitGuardedBatch({
			appId: doc.appId,
			actorUserId: ACTOR,
			expectedProjectId: PROJECT,
			mutations: admitMutationBatch([
				{ kind: "setAppName", name: "Peer's name" },
			]),
			batchId: "peer-batch",
			kind: "autosave",
		});
		const result = await whileBlocked(
			h,
			(pg) =>
				pg.query("SELECT id FROM apps WHERE id = $1 FOR UPDATE", [doc.appId]),
			() => ctx.recordMutations(prepared),
			async (settled, controller) => {
				expect(settled).toBe(false);
				expect(
					(await controller.query("SELECT event FROM events")).rows,
				).toEqual([]);
			},
		);
		expect(result.seq).toBe(2);
		expect(result.committedDoc.appName).toBe("Peer's name");
		expect(result.committedDoc.fields[fieldUuid]).toMatchObject({
			id: "patient_name",
			label: proseText("Full name"),
		});
		expect((await loadApp(doc.appId))?.blueprint).toEqual(
			toPersistableDoc(result.committedDoc),
		);
		await logWriter.flush();
		expect(await readEvents(doc.appId, RUN)).toEqual([
			{
				kind: "mutation",
				runId: RUN,
				ts: expect.any(Number),
				seq: 0,
				actor: "agent",
				source: "mcp",
				mutation: {
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "text",
					patch: { label: proseText("Full name") },
				},
			},
		]);
	} finally {
		await logWriter.flush();
	}
});
it("rejects a stale organization read set before writing, then retries at the current revision without a log sequence hole", async () => {
	const { doc, mcpCtx: ctx, logWriter } = await seed();
	try {
		const prepared = prepareMutationCandidate(
			doc,
			admitMutationBatch([{ kind: "setAppName", name: "Accepted" }]),
		);
		const before = await loadApp(doc.appId);
		await expect(
			ctx.recordMutations(prepared, "automation", {
				expectedOrganizationRevision: "17",
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		await logWriter.flush();
		expect(await loadApp(doc.appId)).toEqual(before);
		expect(await readEvents(doc.appId, RUN)).toEqual([]);
		expect(
			await h.db().selectFrom("app_changes").selectAll().execute(),
		).toEqual([]);
		const result = await ctx.recordMutations(prepared, "automation", {
			expectedOrganizationRevision: "0",
		});
		expect(result.seq).toBe(1);
		expect(result.committedDoc.appName).toBe("Accepted");
		await logWriter.flush();
		expect(await readEvents(doc.appId, RUN)).toEqual([
			{
				kind: "mutation",
				runId: RUN,
				ts: expect.any(Number),
				seq: 0,
				actor: "agent",
				source: "mcp",
				stage: "automation",
				mutation: { kind: "setAppName", name: "Accepted" },
			},
		]);
	} finally {
		await logWriter.flush();
	}
});
