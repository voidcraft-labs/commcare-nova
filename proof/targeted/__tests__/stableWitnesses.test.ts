/**
 * The harness's fixed witnesses retain their actual exported inputs when
 * unrelated admitted documents or fixture counters change. A globally drawn
 * edit would silently cease adding the parent form or leaving the republish
 * byte-identical. The observations are all
 * files Nova's production export writes for each witness, its emitted batch
 * and footprint, and the application in the captured import.
 *
 * HQ's editor and Core's parser prove the witnesses' runtime effects in
 * test_proof4.py, test_proof5_locality.py and test_intent.py; these tests
 * establish that those tests keep receiving the precise inputs they need.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { DEFAULT_CORPUS_SEED } from "../../corpus/defaults";
import type { CorpusDocument } from "../../corpus/documents";
import { storedDocument } from "../../corpus/documents";
import { emitCorpus } from "../../corpus/emitCorpus";
import { targetedUuid } from "../build";
import { noMatchesReturnIdentity } from "../documents/noMatchesReturnIdentity";
import {
	parentFormPreviousFrame,
	parentFormSelectionFrame,
	wireEqualRepublish,
} from "../documents/stableWitnesses";

const makers = [
	parentFormSelectionFrame,
	parentFormPreviousFrame,
	wireEqualRepublish,
	noMatchesReturnIdentity,
];

async function files(root: string): Promise<Map<string, Buffer>> {
	const found = new Map<string, Buffer>();
	for (const entry of await readdir(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name);
			found.set(relative(root, path), await readFile(path));
		}
	}
	return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

async function imported(directory: string, step: string) {
	const sidecar = JSON.parse(
		await readFile(join(directory, `${step}.json`), "utf8"),
	);
	const body = await new Response(
		new Uint8Array(await readFile(join(directory, `${step}.body`))),
		{ headers: { "content-type": sidecar.contentType } },
	).formData();
	const app = body.get("app_file");
	if (!(app instanceof Blob)) throw new Error(`${directory} holds no app file`);
	return JSON.parse(await app.text());
}

function unrelated(): CorpusDocument {
	return {
		id: "unrelated-witness-control",
		source: { kind: "expander", tests: ["a different admitted document"] },
		doc: storedDocument(
			buildDoc({
				modules: [
					{
						name: "Other",
						forms: [
							{
								name: "Other",
								type: "survey",
								fields: [f({ kind: "text", id: "other" })],
							},
						],
					},
				],
			}),
		),
	};
}

describe("the stable harness witnesses", () => {
	let root = "";
	let witnesses: CorpusDocument[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "nova-stable-witnesses-"));
		witnesses = makers.map((make) => make());
		const emit = (name: string, fixed: CorpusDocument[]) =>
			emitCorpus({
				out: join(root, name),
				seed: DEFAULT_CORPUS_SEED,
				sample: 0,
				fixed,
				sampled: [],
				jobs: 1,
				requireEveryKind: false,
			});
		await emit("alone", witnesses);
		const other = unrelated(); // advances every identity the counter can mint
		await emit("beside-another", [other, ...makers.map((make) => make())]);
	});

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("keep every emitted byte when another document changes the balance and fixture counter", async () => {
		for (const document of witnesses) {
			const alone = await files(join(root, "alone", document.id));
			const beside = await files(join(root, "beside-another", document.id));
			expect([...beside.keys()], document.id).toEqual([...alone.keys()]);
			// Each file's bytes compared natively and named when they differ: a
			// deep equality walks every byte of the local archives one by one.
			const differing = [...alone]
				.filter(
					([path, bytes]) => !bytes.equals(beside.get(path) ?? Buffer.alloc(0)),
				)
				.map(([path]) => path);
			expect(differing, document.id).toEqual([]);
		}
	});

	it("add the parent registration while reaching the unchanged child form only by derivation", async () => {
		for (const document of witnesses.slice(0, 2)) {
			const batch = JSON.parse(
				await readFile(
					join(root, "alone", document.id, "edit/batch.json"),
					"utf8",
				),
			);
			expect(batch.kinds, document.id).toEqual(["addForm", "addField"]);
			const child = targetedUuid(document.id, "child-visit");
			expect(batch.touched, document.id).not.toContain(child);
			expect(batch.footprintParts.forms, document.id).toContain(child);
		}
	});

	it("send the same B and B-edit bytes for the form-writing purpose edit", async () => {
		const id = "targeted-wire-equal-republish";
		for (const configuration of ["minimum", "maximum"]) {
			const directory = join(root, "alone", id);
			expect(
				await readFile(
					join(directory, "edit/export", configuration, "update.body"),
				),
				configuration,
			).toEqual(
				await readFile(
					join(directory, "export", configuration, "republish.body"),
				),
			);
			const app = await imported(
				join(directory, "export", configuration),
				"republish",
			);
			expect(app.modules[0].forms).toHaveLength(1);
		}
	});
});
