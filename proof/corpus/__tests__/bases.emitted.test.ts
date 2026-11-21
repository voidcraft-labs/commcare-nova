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
 * A base's document holds the original bytes of each adopted file. Its
 * reading also checks whether HQ can serve media used only in an unshown
 * hint. Saving that file as an asset would upload it on the next publish.
 * Neither an unused mapping nor the Android logos kept in HQ require a read.
 */

import { createHash } from "node:crypto";
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

it(
	"keeps the bytes of adopted assets and distinguishes an unshown hint from an unused mapping",
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
		const reads = media.mediaReads ?? [];
		const unused = "jr://file/commcare/image/data/unused_picture.png";
		const hint = "jr://file/commcare/image/data/note_count_hint.png";
		expect(media.media.map((file) => file.path)).toContain(unused);
		expect(reads.map((read) => read.path)).not.toContain(unused);
		expect(reads.find((read) => read.path === hint)?.status).toBe(200);
		const expected = new Map(
			reads
				.filter((read) => read.status === 200 && read.path !== hint)
				.map((read) => [
					provisionalReadingMediaId(
						"hq-media",
						read.mediaType as HqMediaType,
						read.multimediaId,
					),
					read.sha256,
				]),
		);
		const mediaDocument = await hqAuthoredDocument(media);
		const assets = new Map(
			[...(mediaDocument.media ?? [])].map(([id, file]) => [
				id,
				createHash("sha256").update(file.bytes).digest("hex"),
			]),
		);
		expect(assets).toEqual(expected);
	},
	EMISSION_MS,
);
