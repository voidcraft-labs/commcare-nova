/**
 * The document a deployment was last published from, over seeded pre-step
 * history rows: the stored document, a fold of the frozen pre-step reducer,
 * or the reason there is none.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { rawDocumentDigest, readRawDocument } from "../oldShape";
import { readAppCarriers } from "../plan";
import { readPublishedDocument } from "../publishedDocument";
import {
	readFixtureHistory,
	readFixtureSchemas,
	readHistoryCarriers,
} from "./fixtures/preStep";
import {
	fixtureApp,
	type SeedFixtureApp,
	seedFixtureApp,
} from "./fixtures/seed";

const h = setupAppStateTestDb("hq_cutover_published_", {
	authSchema: "migrated",
});

const OWNER = "owner-published";
const PROJECT = "project-published";
const APP = "app-published";

/** One history's app at its head: the baseline at 1, then each row. */
function historyApp(document: string, name: string): SeedFixtureApp {
	const history = readFixtureHistory(document, name);
	const head = Math.max(...history.rows.map((row) => row.seq));
	return {
		appId: APP,
		projectId: PROJECT,
		owner: OWNER,
		carriers: readHistoryCarriers(document, name, head),
		schemas: readFixtureSchemas(document),
		history,
	};
}

async function published(pushedRevision: number) {
	return h.withTransaction(async (tx) => {
		const stored = await readAppCarriers(tx, APP);
		if (stored === null) throw new Error("The app is not seeded.");
		return readPublishedDocument(tx, {
			appId: APP,
			pushedRevision,
			baseSeq: stored.baseSeq,
			stored: readRawDocument(APP, stored.carriers),
		});
	});
}

function digestOf(document: string, name: string, seq: number): string {
	return rawDocumentDigest(
		readRawDocument(
			APP,
			seq === 1
				? fixtureApp(document, { appId: APP, projectId: PROJECT, owner: OWNER })
						.carriers
				: readHistoryCarriers(document, name, seq),
		),
	);
}

describe("the published document", () => {
	it("is the stored document at the app's present sequence, folding nothing", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		const app = historyApp("navigation-base", "form-renamed");
		await seedFixtureApp(h.db(), {
			...app,
			history: {
				...(app.history ?? { rows: [] }),
				baseline: { seq: 1, snapshotText: JSON.stringify({ appName: "" }) },
			},
		});
		const document = await published(2);
		expect(document).toMatchObject({ kind: "document", source: "stored" });
		expect(
			document.kind === "document" && rawDocumentDigest(document.document),
		).toBe(digestOf("navigation-base", "form-renamed", 2));
	});

	it("folds one row back and several rows back to the document after that row", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			historyApp("targeted-label-sort", "twin-moved"),
		);
		for (const seq of [1, 2]) {
			const document = await published(seq);
			expect(document).toMatchObject({ kind: "document", source: "folded" });
			expect(
				document.kind === "document" && rawDocumentDigest(document.document),
			).toBe(digestOf("targeted-label-sort", "twin-moved", seq));
		}
	});

	it("follows a project move among the rows", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(h.db(), {
			...historyApp("navigation-base", "form-renamed"),
			extraRows: [
				{
					seq: 3,
					kind: "project-move",
					mutationsText: "[]",
					fromProjectId: PROJECT,
					toProjectId: "project-elsewhere",
				},
			],
		});
		const document = await published(2);
		expect(document).toMatchObject({ kind: "document", source: "folded" });
	});

	it("gives two deployments of one app at two sequences each its own document", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			historyApp("targeted-label-sort", "twin-moved"),
		);
		const [first, second] = await Promise.all([published(1), published(3)]);
		expect(first.kind === "document" && rawDocumentDigest(first.document)).toBe(
			digestOf("targeted-label-sort", "twin-moved", 1),
		);
		expect(second).toMatchObject({ kind: "document", source: "stored" });
	});

	it("is none before the app's greatest fold baseline, reading no earlier one", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			historyApp("targeted-label-sort", "twin-moved"),
		);
		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`
				UPDATE app_change_fold_baselines SET snapshot = '{"appName": ""}'::jsonb
				WHERE app_id = ${APP} AND seq = 1
			`.execute(tx);
			await sql`
				INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
				SELECT app_id, 3, ${PROJECT}, snapshot, snapshot_digest
				FROM app_change_fold_baselines WHERE app_id = ${APP} AND seq = 1
			`.execute(tx);
		});
		expect(await published(2)).toEqual({
			kind: "none",
			reason: "before-horizon",
		});
	});

	it("is refused for a missing row or a row the fold refuses, at or below the publish and between it and the head", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			historyApp("targeted-label-sort", "twin-moved"),
		);
		const corrupt = async (seq: number, how: "delete" | "refuse") =>
			h.withTransaction(async (tx) => {
				await sql`SET LOCAL session_replication_role = replica`.execute(tx);
				if (how === "delete") {
					await sql`DELETE FROM app_changes WHERE app_id = ${APP} AND seq = ${seq}`.execute(
						tx,
					);
				} else {
					await sql`
						UPDATE app_changes SET mutations = '[{"kind":"setAppSettings","settings":{}}]'::jsonb
						WHERE app_id = ${APP} AND seq = ${seq}
					`.execute(tx);
				}
			});
		await corrupt(3, "refuse");
		expect(await published(2)).toEqual({
			kind: "none",
			reason: "fold-refused",
		});
		await corrupt(2, "delete");
		expect(await published(2)).toEqual({
			kind: "none",
			reason: "fold-refused",
		});
	});

	it("diverges when a stored carrier changed out of band", async () => {
		await h.seedProjectMember(OWNER, PROJECT, "owner");
		await seedFixtureApp(
			h.db(),
			historyApp("targeted-label-sort", "twin-moved"),
		);
		await h.withTransaction(async (tx) => {
			await sql`SET LOCAL session_replication_role = replica`.execute(tx);
			await sql`UPDATE apps SET app_name = 'Changed out of band' WHERE id = ${APP}`.execute(
				tx,
			);
		});
		expect(await published(2)).toEqual({
			kind: "none",
			reason: "fold-diverges",
		});
	});
});
