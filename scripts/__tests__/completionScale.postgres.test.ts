import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	applyCompletion,
	completionArtifacts,
	scanCompletion,
} from "../lib/hqRoundTripCompletion";
import {
	freezeCompletionSettings,
	step7CompletionStorage,
} from "../lib/step7CompletionStorage";
import {
	seedScaleApp,
	seedScaleTarget,
	seedScaleWorkspace,
} from "./completionScaleFixture";
import {
	backupScaleSource,
	preservedSourceEvidence,
} from "./completionScaleRestore";

const h = setupAppStateTestDb("completion_scale_", {
	authSchema: "migrated",
	caseStoreMigrationsBefore: "20261203",
	poolMax: 3,
});
const run = promisify(execFile);
const receiptPath = process.env.NOVA_STEP7_SCALE_RECEIPT;

const scope = { actor: "synthetic-owner", project: "rehearsal-project" };

async function artifacts(folder: string) {
	const output = join(folder, "artifacts");
	const args = [
		"scripts/prepare-hq-round-trip-artifacts.mjs",
		"--source",
		".",
		"--output",
		output,
	];
	const existing = process.env.NOVA_COMPLETION_TEST_READER;
	if (existing) {
		const reader = resolve(existing);
		args.push(
			"--reader",
			reader,
			"--reader-sha256",
			createHash("sha256")
				.update(await readFile(reader))
				.digest("hex"),
		);
	}
	await run(process.execPath, args, {
		timeout: 180_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	return join(output, "artifacts.json");
}

function share(index: number, count: number, total: number) {
	return (
		Math.floor(((index + 1) * count) / total) -
		Math.floor((index * count) / total)
	);
}

const rehearse = receiptPath ? it : it.skip;
rehearse(
	"rehearses Step 7 at the synthetic retained fleet and workspace volumes",
	async () => {
		if (!receiptPath)
			throw new Error("The hosted rehearsal requires a private receipt path.");
		const folder = await mkdtemp(join(tmpdir(), "nova-scale-"));
		vi.stubEnv("NOVA_DB_LOCAL_URL", h.uri());
		try {
			const manifest = await artifacts(folder);
			const released = await completionArtifacts(manifest);
			const now = () => Math.round(performance.now());
			const start = now();
			const counts = {
				apps: 644,
				learn: 219,
				deliver: 229,
				archived: 127,
				forms: 3014,
				fields: 58845,
				historical: 2406,
				suffixRows: 217,
				suffixApps: 33,
				suffixWithOldRole: 18,
				open: 62,
				affected: 15,
				stages: 1170,
				certificates: 18,
			};
			const suffixApps = [
				...Array.from({ length: 16 }, (_, i) => i),
				...Array.from({ length: 16 }, (_, i) => counts.learn + i),
				counts.learn + counts.deliver,
			];
			const edits = new Map(
				suffixApps.map((app, i) => [
					app,
					share(i, counts.suffixRows, counts.suffixApps),
				]),
			);
			const apps: Awaited<ReturnType<typeof seedScaleApp>>[] = [];
			for (let i = 0; i < counts.apps; i++) {
				apps.push(
					await seedScaleApp(h, released, {
						...scope,
						index: i,
						archived: i >= counts.apps - counts.archived,
						forms: share(i, counts.forms, counts.apps),
						fields: share(i, counts.fields, counts.apps),
						baselines: share(i, counts.historical, counts.apps),
						suffix: edits.get(i) ?? 0,
						suffixReadsOldRole:
							suffixApps.indexOf(i) >= 0 &&
							suffixApps.indexOf(i) < counts.suffixWithOldRole,
						role:
							i < counts.learn
								? "learn"
								: i < counts.learn + counts.deliver
									? "deliver"
									: null,
					}),
				);
			}
			const targetApps = [0, 1, 2, 3, 219, 220, 221, 222, 223, 448];
			let target = 0;
			for (const index of targetApps) {
				await seedScaleTarget(
					h,
					scope,
					apps[index],
					`synthetic-target-${++target}`,
					{ layout: index === 448 },
				);
				if (index !== 223 && index !== 448)
					await seedScaleTarget(
						h,
						scope,
						apps[index],
						`synthetic-target-${++target}`,
					);
			}
			await seedScaleTarget(h, scope, apps[449], "synthetic-unread-target", {
				uncertain: true,
			});

			const oldPrivateIds: string[] = [];
			const appEdits = 37;
			for (let i = 0; i < counts.open; i++) {
				const oldShape = i < 11 || (i >= appEdits && i < appEdits + 4);
				const workspace = await seedScaleWorkspace(h, released, scope, {
					index: i,
					app:
						i < appEdits
							? apps[suffixApps[i] ?? i + counts.learn + 20]
							: undefined,
					stale: i < 12,
					changes:
						i < counts.open - 3 ? share(i, counts.stages, counts.open - 3) : 0,
					oldShape,
				});
				if (oldShape) oldPrivateIds.push(workspace);
			}
			const seeded = now();
			const actual = await sql<{
				apps: number;
				learn: number;
				deliver: number;
				archived: number;
				forms: number;
				fields: number;
				historical: number;
				suffix_rows: number;
				suffix_apps: number;
				suffix_with_old_role: number;
				open_count: number;
				affected: number;
				stages: number;
			}>`SELECT
			(SELECT count(*)::int FROM apps) AS apps,
			(SELECT count(*)::int FROM apps WHERE connect_type = 'learn') AS learn,
			(SELECT count(*)::int FROM apps WHERE connect_type = 'deliver') AS deliver,
			(SELECT count(*)::int FROM apps WHERE deleted_at IS NOT NULL) AS archived,
			(SELECT count(*)::int FROM blueprint_entities WHERE kind = 'form') AS forms,
			(SELECT count(*)::int FROM blueprint_entities WHERE kind = 'field') AS fields,
			(SELECT count(*)::int FROM app_change_fold_baselines) AS historical,
			(SELECT count(*)::int FROM app_changes WHERE kind = 'autosave') AS suffix_rows,
			(SELECT count(DISTINCT app_id)::int FROM app_changes WHERE kind = 'autosave') AS suffix_apps,
			(SELECT count(*)::int FROM app_changes WHERE mutations @> '[{"kind":"setConnectType"}]') AS suffix_with_old_role,
			(SELECT count(*)::int FROM authoring_workspaces WHERE status = 'open') AS open_count,
			(SELECT count(DISTINCT change_set_id)::int FROM authoring_steps WHERE mutations @> '[{"kind":"setConnectType"}]') AS affected,
			(SELECT count(*)::int FROM authoring_steps) AS stages`.execute(h.db());
			expect(actual.rows).toEqual([
				{
					apps: counts.apps,
					learn: counts.learn,
					deliver: counts.deliver,
					archived: counts.archived,
					forms: counts.forms,
					fields: counts.fields,
					historical: counts.historical,
					suffix_rows: counts.suffixRows,
					suffix_apps: counts.suffixApps,
					suffix_with_old_role: counts.suffixWithOldRole,
					open_count: counts.open,
					affected: counts.affected,
					stages: counts.stages,
				},
			]);
			const scanStart = now();
			const settings = await freezeCompletionSettings(h.db(), released);
			const migration = await completionArtifacts(manifest, settings);
			const plan = await scanCompletion(
				h.db(),
				migration,
				step7CompletionStorage,
			);
			const scanned = now();
			const usable = plan.apps.reduce(
				(sum, entry) => sum + entry.inventory.usable,
				0,
			);
			expect(usable).toBe(counts.certificates);
			expect(plan.workspaces).toHaveLength(counts.open);
			expect(
				plan.workspaces.reduce((sum, work) => sum + work.stepCount, 0),
			).toBe(counts.stages);
			const planDigest = canonicalJsonDigest(plan);
			const evidenceDigest = await preservedSourceEvidence(h.db());

			const backup = await backupScaleSource(
				h.uri(),
				h.db(),
				planDigest,
				evidenceDigest,
				migration,
			);
			try {
				const last = plan.apps.at(-1)?.appId;
				if (!last) throw new Error("The last synthetic app is missing.");
				await sql`ALTER TABLE app_changes ADD CONSTRAINT reject_final_synthetic_fold
				CHECK (app_id <> ${sql.lit(last)} OR batch_id <> 'fold-baseline:hq-round-trip-completion') NOT VALID`.execute(
					h.db(),
				);
				const rollbackStarted = now();
				try {
					await expect(
						applyCompletion(h.db(), migration, plan, step7CompletionStorage),
					).rejects.toThrow("reject_final_synthetic_fold");
				} finally {
					await sql`ALTER TABLE app_changes DROP CONSTRAINT reject_final_synthetic_fold`.execute(
						h.db(),
					);
				}
				const rollbackFinished = now();
				expect(
					canonicalJsonDigest(
						await scanCompletion(h.db(), migration, step7CompletionStorage),
					),
				).toBe(planDigest);
				expect(await preservedSourceEvidence(h.db())).toBe(evidenceDigest);
				const rollbackVerified = now();
				const writerStart = now();
				expect(
					await applyCompletion(
						h.db(),
						migration,
						plan,
						step7CompletionStorage,
					),
				).toBe("converted");
				const writerEnd = now();
				expect(
					await applyCompletion(
						h.db(),
						migration,
						plan,
						step7CompletionStorage,
					),
				).toBe("verified");
				const verificationEnd = now();
				const result = await sql<{
					horizons: number;
					learn: number;
					deliver: number;
					activities: number;
					workspace_folds: number;
					converted_old: number;
					certificates: number;
					immutable_old_baselines: number;
				}>`SELECT
				(SELECT count(*)::int FROM app_changes WHERE batch_id = 'fold-baseline:hq-round-trip-completion') AS horizons,
				(SELECT count(*)::int FROM apps WHERE connect_roles = ARRAY['learn']) AS learn,
				(SELECT count(*)::int FROM apps WHERE connect_roles = ARRAY['deliver']) AS deliver,
				(SELECT count(*)::int FROM blueprint_entities WHERE data->>'kind' = 'connect_activity') AS activities,
				(SELECT count(*)::int FROM authoring_workspace_folds) AS workspace_folds,
				(SELECT count(DISTINCT change_set_id)::int FROM authoring_step_folds WHERE change_set_id = ANY(${oldPrivateIds}::uuid[])) AS converted_old,
				(SELECT count(*)::int FROM app_deployment_baselines WHERE reference_fold_seq IS NOT NULL AND origin = 'push') AS certificates,
				(SELECT count(*)::int FROM app_change_fold_baselines) - (SELECT count(*)::int FROM apps) AS immutable_old_baselines`.execute(
					h.db(),
				);
				const activities = apps.reduce(
					(sum, app, i) =>
						sum + (app.role ? share(i, counts.forms, counts.apps) : 0),
					0,
				);
				expect(result.rows).toEqual([
					{
						horizons: counts.apps,
						learn: counts.learn,
						deliver: counts.deliver,
						activities,
						workspace_folds: counts.open,
						converted_old: counts.affected,
						certificates: counts.certificates,
						immutable_old_baselines: counts.historical,
					},
				]);
				const restore = await backup.restore();
				await writeFile(
					receiptPath,
					`${JSON.stringify(
						{
							counts,
							planDigest,
							evidenceDigest,
							reader: migration.provenance,
							seedMs: seeded - start,
							scanMs: scanned - scanStart,
							rollbackMs: rollbackFinished - rollbackStarted,
							rollbackVerificationMs: rollbackVerified - rollbackFinished,
							writerMs: writerEnd - writerStart,
							verificationMs: verificationEnd - writerEnd,
							restoration: restore,
							result: result.rows[0],
						},
						null,
						2,
					)}\n`,
					{ flag: "wx", mode: 0o600 },
				);
			} finally {
				await backup.clean();
			}
		} finally {
			vi.unstubAllEnvs();
			await rm(folder, { recursive: true, force: true });
		}
	},
	1_800_000,
);
