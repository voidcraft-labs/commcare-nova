import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { appendSyntheticBatch, loadApp } from "@/lib/db/apps";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	migrateCaseSelectionEntry,
	scanCaseSelection,
	verifyCaseSelectionManifest,
} from "../caseSelectionMigration";

import { repairAuthoringBaseline } from "../repairAuthoringBaselines";

const h = setupAppStateTestDb("case_selection_");
function fixture() {
	return buildDoc({
		caseTypes: [
			{ name: "garden", properties: [] },
			{ name: "plot", parent_type: "garden", properties: [] },
		],
		modules: [
			...["Garden first", "Garden second"].map((name) => ({
				name,
				caseType: "garden",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			})),
			{
				name: "Plots",
				caseType: "plot",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			},
		],
	});
}
async function planned() {
	const appId = await h.seedAppWithBlueprint(fixture());
	await repairAuthoringBaseline(appId);
	const manifest = verifyCaseSelectionManifest(
		await scanCaseSelection("old-revision", [appId]),
	);
	const entry = manifest.entries[0];
	if (!entry) throw new Error("Missing scanned app");
	return { appId, entry, manifest };
}

describe("parent-selection cutover", () => {
	it("preserves old parent datums before the new semantics can admit the source", async () => {
		const garden = testUuid("legacy-garden"),
			plot = testUuid("legacy-plot"),
			visit = testUuid("legacy-visit");
		const doc = buildDoc({
			caseTypes: [
				{ name: "garden", properties: [] },
				{ name: "plot", parent_type: "garden", properties: [] },
			],
			modules: [
				{
					uuid: garden,
					name: "Gardens",
					caseType: "garden",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
				{
					uuid: plot,
					name: "Plots",
					caseType: "plot",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: visit,
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
				{
					name: "Start",
					forms: [
						{
							name: "Choose",
							type: "survey",
							fields: [f({ kind: "text", id: "note" })],
							formLinks: [
								{
									target: { type: "form", moduleUuid: plot, formUuid: visit },
									datums: [
										{ name: "parent_id", xpath: "'garden-id'" },
										{ name: "case_id", xpath: "'plot-id'" },
									],
								},
							],
						},
					],
				},
			],
		});
		const appId = await h.seedAppWithBlueprint(doc);
		await expect(loadApp(appId)).rejects.toThrow("FORM_LINK_DATUM_UNUSED");
		expect(await repairAuthoringBaseline(appId)).toMatchObject({
			status: "repaired",
		});
		const manifest = verifyCaseSelectionManifest(
			await scanCaseSelection("old-revision", [appId]),
		);
		expect(await migrateCaseSelectionEntry(manifest.entries[0])).toMatchObject({
			status: "migrated",
		});
		expect(
			(await loadApp(appId))?.blueprint.modules[plot].parentCaseModuleUuid,
		).toBe(garden);
	});
	it("preserves the old selector with replayable history; retries keep later edits and exclude new apps", async () => {
		const { appId, entry, manifest } = await planned();
		expect(entry.routes).toHaveLength(1);
		const sessionId = await h.seedDesignSession({
			app_id: appId,
			state: "materialized",
		});
		await h
			.db()
			.updateTable("apps")
			.set({ status: "error" })
			.where("id", "=", appId)
			.execute();
		await sql`INSERT INTO authoring_plans (session_id, revision) VALUES (${sessionId}::uuid, 1)`.execute(
			h.db(),
		);
		await sql`INSERT INTO authoring_plan_revisions (session_id, revision, markdown, editor, run_id, request_id, request_digest) VALUES (${sessionId}::uuid, 1, 'Track plots.', 'migration', 'old-run', 'old-request', ${"a".repeat(64)})`.execute(
			h.db(),
		);
		const workspaceId = randomUUID();
		await sql`INSERT INTO authoring_workspaces (id, design_session_id, plan_revision, kind, app_id, base_seq, base_project_id, base_snapshot_digest, owner_user_id, owner_run_id, status) VALUES (${workspaceId}::uuid, ${sessionId}::uuid, 1, 'app-edit', ${appId}, ${entry.baseSeq}, ${entry.projectId}, ${entry.baseDigest}, 'user-owner', 'old-run', 'open')`.execute(
			h.db(),
		);
		expect(await migrateCaseSelectionEntry(entry)).toMatchObject({
			status: "migrated",
		});
		const saved = await loadApp(appId);
		if (!saved) throw new Error("Missing app");
		expect(saved.status).toBe("error");
		expect(
			saved.blueprint.modules[entry.routes[0].moduleUuid].parentCaseModuleUuid,
		).toBe(saved.blueprint.moduleOrder[0]);
		expect(
			(
				await h
					.db()
					.selectFrom("authoring_workspaces")
					.select("status")
					.where("id", "=", workspaceId)
					.executeTakeFirstOrThrow()
			).status,
		).toBe("abandoned");
		await h.withTransaction(async (tx) => {
			const folded = await loadCanonicalBlueprintAtSequence(tx, {
				appId,
				seq: saved.mutation_seq,
				expectedDigest: entry.targetDigest,
			});
			expect(folded.projectId).toBe(entry.projectId);
		});
		const flat = structuredClone(saved.blueprint);
		delete flat.modules[entry.routes[0].moduleUuid].parentCaseModuleUuid;
		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: saved.mutation_seq,
			targetDoc: flat,
			authority: {
				kind: "system",
				actorId: "system:test-edit",
				reason: "Deliberate later flat selection",
			},
		});
		const newApp = await h.seedAppWithBlueprint(fixture());
		expect(
			await migrateCaseSelectionEntry(
				verifyCaseSelectionManifest(manifest).entries[0],
			),
		).toMatchObject({ status: "already-applied" });
		expect((await loadApp(appId))?.blueprint).toEqual(flat);
		expect(
			Object.values((await loadApp(newApp))?.blueprint.modules ?? {}).every(
				(module) => module.parentCaseModuleUuid === undefined,
			),
		).toBe(true);
	});

	it("rejects stale bases and active runs without writing a partial migration", async () => {
		const { appId, entry } = await planned();
		const before = await loadApp(appId);
		for (const invalid of [
			{ ...entry, projectId: "wrong" },
			{ ...entry, baseSeq: entry.baseSeq + 1 },
			{ ...entry, baseDigest: "wrong" },
			{ ...entry, targetDigest: "wrong" },
		])
			await expect(migrateCaseSelectionEntry(invalid)).rejects.toThrow();
		expect(await loadApp(appId)).toEqual(before);
		await sql`UPDATE apps SET lock_run_id = 'active', lock_actor_user_id = 'user-owner', lock_expire_at = now() + interval '1 minute', run_holder_nonce = ${randomUUID()}::uuid WHERE id = ${appId}`.execute(
			h.db(),
		);
		await expect(migrateCaseSelectionEntry(entry)).rejects.toThrow(
			"run or unsettled",
		);
		expect(
			(
				await h
					.db()
					.selectFrom("apps")
					.select("mutation_seq")
					.where("id", "=", appId)
					.executeTakeFirstOrThrow()
			).mutation_seq,
		).toBe(String(entry.baseSeq));
	});

	it("refuses a modified manifest before execution", async () => {
		const { manifest } = await planned();
		expect(() =>
			verifyCaseSelectionManifest({ ...manifest, sourceRevision: "different" }),
		).toThrow("fingerprint");
		const { digest: _digest, ...body } = manifest;
		const repeated = { ...body, entries: [...body.entries, ...body.entries] };
		expect(() =>
			verifyCaseSelectionManifest({
				...repeated,
				digest: canonicalJsonDigest(repeated),
			}),
		).toThrow("repeats an app");
	});
});
