/**
 * Every app the proof lane authored in CommCare HQ and retained
 * (`proof/hq-apps/<base>/`), emitted as the lane's emission emits it: the
 * base's first reading made its document (`../hqAuthored.ts::hqAuthoredDocument`),
 * then `../emitCorpus.ts::emitCorpus`, which publishes it, plans its edit,
 * republishes over HQ's own source through the capture, expands its hand
 * expectations for each state and compiles its local archive.
 *
 * Contract: the tree holds every base the lane's registry names; each base
 * is emitted whole, a document of the fixed floor with nothing refused, its
 * first publish, its republish, its expectations, its local archive exactly
 * where its declaration includes Android and its project space's app keeps no
 * custom base URL elsewhere, the download's refusal in the archive's place
 * exactly where it keeps one (`inputs.ts::LOCAL_REFUSED`,
 * `workers-sent-elsewhere`, as `hq-kept-settings` does), and its edit
 * exactly where its hand directory states one. The plausible failures: a retained tree the
 * emission cannot read (the lane's emission then stops at that base and no
 * document of the corpus is checked), a base Nova's publish, its local
 * export or its commit gate refuses though its reader accepted it, and a
 * hand file that names a form or a value the base's document does not
 * hold. Each base is its own case, so a failure names the base.
 *
 * A base's document holds the files its reading holds and no other.
 * Contract: an asset per file HQ answered the reading for, and none for a
 * file HQ maps that the reading never asks for: one only a setting kept in
 * CommCare HQ names (`hq-kept-settings`' Android logos) or one nothing
 * references. The plausible failures: a loader that demands a read of every
 * file `media.json` maps, which stops the emission at the first base whose
 * map holds a kept logo, and one that makes such a file an asset, which
 * Nova's publish would upload and keep as the app's own.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	NAMED_BASES,
	RETAINED_BASES,
	retainedBase,
} from "@/__tests__/helpers/retainedHqApps";
import type { HqMediaType } from "@/lib/commcare/hq/appSource";
import { targetFactsFromSource } from "@/lib/commcare/targetFacts";
import { provisionalReadingMediaId } from "@/lib/deployment/reading/mediaIds";
import { workersSentElsewhere } from "@/lib/deployment/runtimeTarget";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { WORKTREE } from "../emissionProcess";
import { emitCorpus } from "../emitCorpus";
import { HQ_HAND, hqAuthoredDocument } from "../hqAuthored";
import { LOCAL_REFUSED } from "../inputs";
import { PROOF_SERVER } from "../publish";

/*
 * A base's emission is its reading, its first publish, its edit and the
 * captures, archives and expectations the writer makes: under a second to
 * 10 s for one base on four throttled cores (a starter app is the largest),
 * about 35 s for every base, several times that while a batch shares them.
 */
const EMISSION_MS = 120_000;

it("holds every base the lane's registry names", () => {
	expect(RETAINED_BASES).toEqual(NAMED_BASES);
});

it.each(RETAINED_BASES)(
	"emits the base %s whole",
	async (id) => {
		const out = await mkdtemp(join(tmpdir(), `nova-base-${id}-`));
		try {
			const app = retainedBase(id);
			const document = await hqAuthoredDocument(app);
			const { index } = await emitCorpus({
				out,
				seed: DEFAULT_CORPUS_SEED,
				sample: 0,
				fixed: [document],
				sampled: [],
			});
			const { refused, editsRefused, withoutEdit } = index.census.fixed;
			expect({ refused, editsRefused, withoutEdit }).toEqual({
				refused: [],
				editsRefused: [],
				withoutEdit: [],
			});
			expect(index.documents.map((entry) => entry.id)).toEqual([id]);
			const root = join(out, id);
			for (const file of [
				"document.json",
				"verdict.json",
				"first-publish.json",
				"expected.json",
				"restore.xml",
				"export",
			])
				expect(existsSync(join(root, file)), `${id}/${file}`).toBe(true);
			const declaration = document.hqAuthored?.declaration;
			const android = declaration?.runsOnlyOn !== "web-apps";
			const facts = targetFactsFromSource(
				JSON.parse(app.source.body ?? "null"),
				{
					observedAt: "2026-11-01T00:00:00.000Z",
					novaOwnsAutoGpsCapture: false,
					adopted: true,
				},
			);
			const elsewhere =
				workersSentElsewhere(
					{ server: PROOF_SERVER },
					facts?.customBaseUrl ?? null,
				) !== null;
			expect(existsSync(join(root, "local.ccz")), `${id}/local.ccz`).toBe(
				android && !elsewhere,
			);
			expect(
				existsSync(join(root, LOCAL_REFUSED)),
				`${id}/${LOCAL_REFUSED}`,
			).toBe(android && elsewhere);
			expect(existsSync(join(root, "edit")), `${id}/edit`).toBe(
				existsSync(join(WORKTREE, HQ_HAND, id, "edit.ts")),
			);
		} finally {
			await rm(out, { recursive: true, force: true });
		}
	},
	EMISSION_MS,
);

/** The asset id of each file HQ answered a base's reading for. */
function readAssets(id: string): string[] {
	const app = retainedBase(id);
	return [
		...new Set(
			(app.mediaReads ?? [])
				.filter((read) => read.status === 200)
				.map((read) =>
					provisionalReadingMediaId(
						id,
						read.mediaType as HqMediaType,
						read.multimediaId,
					),
				),
		),
	].sort();
}

it(
	"gives a base's document the files its reading holds, and none HQ keeps for a setting or maps unreferenced",
	async () => {
		const kept = retainedBase("hq-kept-settings");
		expect(kept.media.map((file) => file.path)).toEqual([
			"jr://file/commcare/logo/data/hq_logo_android_home.png",
			"jr://file/commcare/logo/data/hq_logo_android_login.png",
		]);
		expect(kept.mediaReads).toBeUndefined();
		const keptDocument = await hqAuthoredDocument(kept);
		expect(keptDocument.media).toBeUndefined();
		expect([...(keptDocument.hqAuthored?.mediaPaths ?? [])]).toEqual([]);

		const media = retainedBase("hq-media");
		const unread = media.media
			.map((file) => file.path)
			.filter(
				(path) => !(media.mediaReads ?? []).some((read) => read.path === path),
			);
		expect(unread).toContain(
			"jr://file/commcare/image/data/unused_picture.png",
		);
		const mediaDocument = await hqAuthoredDocument(media);
		expect([...(mediaDocument.media?.keys() ?? [])].sort()).toEqual(
			readAssets("hq-media"),
		);
	},
	EMISSION_MS,
);
