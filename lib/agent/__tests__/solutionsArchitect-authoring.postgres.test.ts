/** Real thread ownership, private staging, canonical saves and chat projection.
 * Provider request serialization is covered by wireCacheConfig.test.ts. */
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { claimAndReserveRun, loadApp, setAwaitingInput } from "@/lib/db/apps";
import { upsertThreadTurn } from "@/lib/db/threads";
import { asUuid } from "@/lib/domain";
import {
	createLocation,
	describeArchiveImpact,
} from "@/lib/organization/service";
import { openChatWork } from "../authoring/chatWork";
import { discardWork, getWork } from "../authoring/session";
import { createSolutionsArchitect } from "../solutionsArchitect";
import { makeTestContext } from "./fixtures";
import { runSaTool } from "./saHarness";

const db = setupAppStateTestDb();
async function setup() {
	const runId = crypto.randomUUID();
	const holderNonce = crypto.randomUUID();
	await db.seedProjectMember("user-1", "project-test", "owner");
	const { appId } = await createExplicitBlankApp(
		"user-1",
		"project-test",
		crypto.randomUUID(),
		{ name: "Original", status: "complete" },
	);
	await claimAndReserveRun(
		appId,
		"edit",
		runId,
		"user-1",
		0,
		"project-test",
		holderNonce,
	);
	const threadId = crypto.randomUUID();
	await upsertThreadTurn({
		target: { kind: "app", appId },
		threadId,
		runId,
		streamId: crypto.randomUUID(),
		holderNonce,
		threadType: "edit",
		messages: [],
		expectedProjectId: "project-test",
	});
	const handles = makeTestContext({
		appId,
		editLease: true,
		seed: { runId, holderNonce },
	});
	const work = await openChatWork(handles.ctx, threadId);
	return {
		...handles,
		appId,
		threadId,
		work,
		agent: createSolutionsArchitect(handles.ctx, work),
	};
}

describe("ordinary chat private authoring", () => {
	it.each(["paused", "expired"] as const)(
		"allows explicit discard after a %s run, but rejects it while live",
		async (state) => {
			const { ctx, work, agent, appId, threadId } = await setup();
			try {
				await runSaTool(agent, "updateApp", { name: "Pending name" });
				const pending = await work.status();
				if (!pending.revision) throw new Error("No pending work");
				const args = {
					actorUserId: "user-1",
					workId: pending.workId,
					host: { kind: "chat", threadId } as const,
					requestId: "explicit-discard",
					expectedRevision: pending.revision,
				};
				await expect(discardWork(args)).rejects.toThrow(
					"Wait for the active run",
				);
				if (state === "paused") {
					await setAwaitingInput(
						appId,
						ctx.runId,
						ctx.chatRunHolder.nonce,
						"edit",
						true,
						"user-1",
						"project-test",
					);
				} else {
					await db
						.db()
						.updateTable("apps")
						.set({ lock_expire_at: new Date(0) })
						.where("id", "=", appId)
						.execute();
				}
				await discardWork(args);
				expect(await getWork(args)).toMatchObject({ pendingChanges: 0 });
				expect((await loadApp(appId))?.app_name).toBe("Original");
			} finally {
				await ctx.stopRunLeaseHeartbeat();
			}
		},
	);

	it("publishes an exact mixed checkpoint, adopts it for subsequent edits, and never regresses on replay", async () => {
		const { ctx, work, agent, appId, writer } = await setup();
		try {
			const levelUuid = asUuid(crypto.randomUUID());
			const personaUuid = asUuid(crypto.randomUUID());
			await runSaTool(agent, "addOrganizationLevels", {
				levels: [
					{
						uuid: levelUuid,
						code: "clinic",
						name: "Clinic",
						description: null,
						caseFlow: {
							workers: "assigned",
							ownsCases: true,
							descendantCases: { kind: "none" },
						},
						addressBook: { reach: "own-branch" },
					},
				],
			});
			await work.invoke(
				"saveWork",
				{ expectedRevision: (await work.status()).revision },
				"save-levels",
			);
			const scope = {
				appId,
				projectId: "project-test",
				actorUserId: "user-1",
				role: "owner" as const,
			};
			const { location } = await createLocation(scope, {
				levelUuid,
				parentId: null,
				name: "North Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
			});
			await runSaTool(agent, "addPersonas", {
				personas: [{ personaUuid, name: "Asha", locationUuids: [location.id] }],
			});
			await work.invoke(
				"saveWork",
				{ expectedRevision: (await work.status()).revision },
				"save-persona",
			);
			const impact = await describeArchiveImpact(scope, location.id);
			const input = {
				locationUuid: location.id,
				archived: true,
				confirm: true,
				expectedRevision: impact.revision,
				confirmedImpact: impact,
			};
			const before = ctx.latestCommittedSeq();
			expect(
				await work.invoke("setLocationArchived", input, "archive"),
			).toMatchObject({ ok: true });
			expect(ctx.latestCommittedSeq()).toBe((before ?? 0) + 1);
			const archivedPersona = ctx.latestPersistedDoc()?.personas?.[personaUuid];
			expect(archivedPersona).toMatchObject({ name: "Asha" });
			expect(archivedPersona?.locations).toBeUndefined();
			await runSaTool(agent, "updateApp", { name: "After archive" });
			await work.invoke(
				"saveWork",
				{ expectedRevision: (await work.status()).revision },
				"save-after-archive",
			);
			const afterSave = ctx.latestCommittedSeq();
			const emitted = writer.write.mock.calls.filter(
				([frame]) => frame.type === "data-mutations",
			).length;
			await work.invoke("setLocationArchived", input, "archive");
			expect(ctx.latestCommittedSeq()).toBe(afterSave);
			expect(ctx.latestPersistedDoc()?.appName).toBe("After archive");
			expect(
				writer.write.mock.calls.filter(
					([frame]) => frame.type === "data-mutations",
				),
			).toHaveLength(emitted);
		} finally {
			await ctx.stopRunLeaseHeartbeat();
		}
	});

	it("serializes staged siblings, survives reopening, and emits only the saved checkpoint", async () => {
		const { ctx, work, agent, appId, threadId, writer } = await setup();
		try {
			const before = await loadApp(appId);
			const moduleUuid = asUuid(crypto.randomUUID());
			const formUuid = asUuid(crypto.randomUUID());
			await Promise.all([
				runSaTool(agent, "createModule", { moduleUuid, name: "Visits" }),
				runSaTool(agent, "createForm", {
					formUuid,
					moduleUuid: "Visits",
					name: "Visit",
					type: "survey",
				}),
			]);
			expect(await loadApp(appId)).toMatchObject({
				mutation_seq: before?.mutation_seq,
			});
			expect(
				writer.write.mock.calls.filter(
					([frame]) => frame.type === "data-mutations",
				),
			).toHaveLength(0);
			const resumed = await openChatWork(ctx, threadId);
			expect((await resumed.status()).pendingChanges).toBe(2);
			await runSaTool(agent, "addFields", {
				moduleUuid: "Visits",
				formUuid: "Visit",
				fields: [{ id: "notes", kind: "text", label: "Notes" }],
			});
			const pending = await work.status();
			const saved = await work.invoke(
				"saveWork",
				{ expectedRevision: pending.revision },
				"save-checkpoint",
			);
			expect(saved).toMatchObject({ saved: true });
			expect((await work.status()).pendingChanges).toBe(0);
			expect((await loadApp(appId))?.blueprint.modules[moduleUuid].name).toBe(
				"Visits",
			);
			const frames = writer.write.mock.calls.filter(
				([frame]) => frame.type === "data-mutations",
			);
			expect(frames).toHaveLength(1);
			expect(frames[0][0].data.mutations.length).toBeGreaterThan(2);
			await work.invoke(
				"saveWork",
				{ expectedRevision: pending.revision },
				"save-checkpoint",
			);
			expect(
				writer.write.mock.calls.filter(
					([frame]) => frame.type === "data-mutations",
				),
			).toHaveLength(1);
		} finally {
			await ctx.stopRunLeaseHeartbeat();
		}
	});
});
