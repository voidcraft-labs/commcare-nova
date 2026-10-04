/**
 * The corpus emitter writes only admitted documents, and writes them the
 * same way, byte for byte, on every run for a seed.
 *
 * Contract: every document `emitCorpus` writes (D in `document.json`, D′ in
 * `edit/document.json`) is one Nova's stores hold and admit (the strict
 * schema and full validation, read back from the files the checks read); a
 * document Nova's publish refuses is left out and named with the boundary's
 * findings; and two emissions of one corpus at one seed are byte-identical
 * file for file, the minted identities included, whatever the time, the
 * process that writes a document, or which other documents are written
 * with it (`./entropy.mts` seeds each export by the corpus seed, its
 * ordinal and its configuration). The plausible failures: a written
 * document that no Nova store would hold (a hydrated field left in, a lookup
 * cell or upload the store would refuse), an edited document the commit
 * gate never admitted, a refused document slipping into the corpus, and a
 * source of variation (a clock, an unordered collection, a random boundary,
 * a draw made outside its operation or shared between two) making every
 * comparison over the corpus noisy and no observation reusable. Seeding must
 * keep what Nova keeps apart: a document's create and republish mint
 * different module and form ids and `xmlns` (defect 1), and its two local
 * exports different profile `uniqueid`s (defect 9), or the corpus would hide
 * those defects from the checks that must see them. And seeding must keep
 * apart what proof 5 maps: an update to D′ that sends anything but the
 * republish of D mints none of the ids that republish minted, or an id of
 * D′ would name another entity of D (one stream mints, in order, D's ids
 * for whatever D′ holds in their places), while an update that sends
 * exactly the republish is byte-identical to it.
 *
 * A publish whose export carries media sends it after the import
 * (`lib/deployment/service.ts::uploadMediaBytes`), and the HQ side replays
 * that upload, so its capture must be written beside the import, named by
 * the import's sidecar and by the input manifest. The plausible failures: a
 * document whose import maps media with no upload written (HQ's state would
 * keep Nova's map, which no HQ ever holds after a publish), an upload that
 * carries other files than the paths the import maps, and a document
 * without media gaining any file or role (its records would change). The
 * observation is the import's `multimedia_map` beside the written upload.
 *
 * Each document's `document.json` places its languages on the wire
 * (`wire.languages`), which proof 1 pairs across an edit by tag; the
 * plausible failure is an order or a code other than the `langs` Nova's
 * import actually sends, so the observation is the app JSON in the
 * captured import bodies.
 *
 * The census names, per mutation kind, the fixed documents whose written
 * batch was drawn for it, and the lane's emission (`requireEveryKind`)
 * stops before writing anything when a kind lands on no fixed document. The
 * plausible failures are a census that files a batch under a kind other
 * than the one it was drawn for (another kind among its mutations) or
 * counts the sample's batches toward the fixed floor, so a kind looks
 * covered on the floor that is not; and a floor that lets a corpus missing
 * a kind be written, or names other kinds than the missing ones. The
 * observation is the written `edit/batch.json` files and the floor's
 * refusal over the same documents. Nova's publish and local export take
 * every edit batch drawn here, so this corpus does not show the census
 * leaving out an edit they refuse.
 *
 * A targeted document is written with the files its expectations read
 * (`CorpusDocument.files`) and no edit but the one written for it, and the
 * fixed floor's batches are balanced without it. The plausible failure: a
 * targeted document drawn into the floor's balance, which would move other
 * documents' batches, and so every record keyed by their B-edit, whenever
 * one is added. The observation is every other document's written
 * `edit/batch.json` with and without one. A targeted document that writes
 * D′, what a person saves in HQ over A and the project settings it needs
 * is written with that edit as its batch (the mutations Nova's gate
 * admitted, never redrawn), `hq-side.json` keying its A, and every
 * configuration holding those settings; the plausible failures are an
 * edit, a save or a setting lost on the way to the files the lane reads.
 *
 * The corpus here is small but spans what the emitter treats differently:
 * producer documents with lookup data and uploaded media, three languages
 * whose wire codes are not their tags, a workforce document over a producer
 * document with media, one document Nova's publish refuses, and two fuzz
 * draws with their generated media.
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, effectiveAppLocalization } from "@/lib/domain";
import { hqSideState } from "../../targeted/documents/hqSideState";
import { lookupReservedTags } from "../../targeted/documents/lookupReservedTags";
import { syncOnFormEntry } from "../../targeted/documents/searchApps";
import { CORPUS_COMMCARE_VERSION } from "../configurations";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { type CorpusDocument, lookupContextOf } from "../documents";
import { EDIT_KINDS } from "../editBatches";
import {
	type EmittedCorpus,
	emitCorpus,
	UnlandedKindsError,
} from "../emitCorpus";
import { sampleFuzzDocuments } from "../fuzzSample";
import { producerDocuments } from "../producers";
import { workforceDocumentId, workforceDocuments } from "../workforce";
import { readDocuments } from "../writePublishCaptures";

/** Producer documents that span lookup data, uploaded media, search, case writes, languages and a refusal. */
const PRODUCER_IDS = [
	"arithmetic",
	"case-worker-survey",
	"lookup-app",
	"media-rich",
	"prompt-widgets",
	"no-matches-basic",
	"localization-mandarin",
	"nested-menu-same-smaller",
];
const REFUSED = "nested-menu-same-smaller";
/** A workforce document over a producer document that carries uploaded media. */
const WORKFORCE_ID = workforceDocumentId("case-list-local");

async function files(root: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	for (const entry of await readdir(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		out.set(relative(root, path), await readFile(path));
	}
	return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** A privilege a reproduction names for one document (`CorpusDocument.privileges`). */
const NAMED_PRIVILEGE = "CLOUDCARE";
const NAMING = "case-worker-survey";

interface ImportedApp {
	readonly langs: string[];
	readonly multimedia_map?: Record<string, unknown>;
	readonly modules: {
		readonly unique_id: string;
		readonly forms: { readonly unique_id: string; readonly xmlns: string }[];
	}[];
}

/** The app JSON a captured import carries, read through its sidecar's content type. */
async function importedApp(
	directory: string,
	name: string,
): Promise<ImportedApp> {
	const sidecar = JSON.parse(
		await readFile(join(directory, `${name}.json`), "utf8"),
	);
	const form = await new Response(
		new Uint8Array(await readFile(join(directory, `${name}.body`))),
		{ headers: { "content-type": sidecar.contentType } },
	).formData();
	const file = form.get("app_file");
	if (!(file instanceof Blob)) {
		throw new Error(`${directory}/${name} carries no app file.`);
	}
	return JSON.parse(await file.text());
}

/** The profile `uniqueid` a local archive carries, read from its parsed profile. */
function profileUniqueId(archive: Buffer): string | undefined {
	const profile = new AdmZip(archive).readAsText("profile.ccpr");
	const parsed = parseXml(profile);
	const root = parsed.children.find(isTag);
	return root?.attribs.uniqueid;
}

async function emit(
	out: string,
	fixed: readonly CorpusDocument[],
	sampled: readonly CorpusDocument[],
	options: {
		readonly jobs?: number;
		readonly requireEveryKind?: boolean;
		readonly only?: readonly string[];
	} = {},
): Promise<EmittedCorpus> {
	const only = options.only;
	return emitCorpus({
		out,
		seed: DEFAULT_CORPUS_SEED,
		sample: sampled.length,
		fixed,
		sampled,
		jobs: options.jobs ?? 1,
		requireEveryKind: options.requireEveryKind ?? false,
		...(only !== undefined && {
			select: { label: "chosen", includes: (id) => only.includes(id) },
		}),
	});
}

describe("the corpus emitter", () => {
	let root = "";
	let producers: CorpusDocument[] = [];
	let fixed: CorpusDocument[] = [];
	let sampled: CorpusDocument[] = [];
	let index: EmittedCorpus["index"] | undefined;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "nova-corpus-emit-"));
		producers = producerDocuments();
		const byId = new Map(producers.map((d) => [d.id, d]));
		const workforce = workforceDocuments(producers).find(
			(document) => document.id === WORKFORCE_ID,
		);
		if (workforce === undefined) {
			throw new Error(`The workforce documents hold no ${WORKFORCE_ID}.`);
		}
		fixed = [
			...PRODUCER_IDS.map((id) => {
				const document = byId.get(id);
				if (document === undefined) {
					throw new Error(`The producers emit no document ${id}.`);
				}
				return id === NAMING
					? { ...document, privileges: [NAMED_PRIVILEGE] }
					: document;
			}),
			workforce,
		];
		sampled = sampleFuzzDocuments({
			size: 2,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		}).map((sample) => sample.document);
		({ index } = await emit(join(root, "nova"), fixed, sampled));
	});

	afterAll(async () => {
		vi.useRealTimers();
		await rm(root, { recursive: true, force: true });
	});

	it("emits every document Nova's publish takes and names the one it refuses", () => {
		expect(index?.documents.map((d) => d.id)).toEqual([
			...PRODUCER_IDS.filter((id) => id !== REFUSED),
			WORKFORCE_ID,
			...sampled.map((d) => d.id),
		]);
		expect(index?.census.fixed.refused).toEqual([
			expect.objectContaining({
				id: REFUSED,
				by: "publish",
				codes: ["HQ_NESTED_SELECTION_UNREPRESENTABLE"],
			}),
		]);
		expect(index?.census.sample.refused).toEqual([]);
	});

	it("writes documents, and edited documents, that Nova's stores hold and admit", async () => {
		for (const entry of index?.documents ?? []) {
			const directory = join(root, "nova", entry.id);
			const written = [
				JSON.parse(await readFile(join(directory, "document.json"), "utf8")),
			];
			if (entry.edit) {
				written.push(
					JSON.parse(
						await readFile(join(directory, "edit", "document.json"), "utf8"),
					),
				);
			}
			for (const document of written) {
				// The stored-state reader refuses a lookup cell or upload the store would not hold.
				const [stored] = readDocuments([document]);
				if (stored === undefined)
					throw new Error(`${entry.id} read as nothing.`);
				const doc = hydratePersistedBlueprint(
					blueprintDocSchema.parse(stored.document.doc),
				);
				expect(
					runValidation(doc, lookupContextOf(stored.document.lookup)).map(
						(f) => f.code,
					),
					entry.id,
				).toEqual([]);
			}
		}
		expect(index?.documents.filter((d) => d.edit).length).toBeGreaterThan(0);
	});

	it("places each document's languages on the wire in the order and with the codes of the langs its imports send", async () => {
		const multilingual: string[] = [];
		for (const entry of index?.documents ?? []) {
			const directory = join(root, "nova", entry.id);
			const sides = [
				{ root: directory, step: "create" },
				...(entry.edit
					? [{ root: join(directory, "edit"), step: "update" }]
					: []),
			];
			for (const side of sides) {
				const written = JSON.parse(
					await readFile(join(side.root, "document.json"), "utf8"),
				);
				const languages: { tag: string; code: string }[] =
					written.wire.languages;
				const stored = hydratePersistedBlueprint(
					blueprintDocSchema.parse(written.doc),
				);
				expect(
					languages.map((language) => language.tag),
					`${entry.id} ${side.step}`,
				).toEqual(effectiveAppLocalization(stored.localization).languageOrder);
				for (const configuration of entry.configurations) {
					const app = await importedApp(
						join(side.root, "export", configuration),
						side.step,
					);
					expect(
						languages.map((language) => language.code),
						`${entry.id} ${side.step} ${configuration}`,
					).toEqual(app.langs);
				}
				if (languages.length > 1) {
					multilingual.push(`${entry.id} ${side.step}`);
				}
			}
		}
		// More than English alone was placed: the Mandarin document's three
		// languages, two told apart only by script, and the language a
		// workforce document adds.
		expect(multilingual).toEqual(
			expect.arrayContaining([
				"localization-mandarin create",
				`${WORKFORCE_ID} create`,
			]),
		);
	});

	it("writes the media upload each publish sends after an import that maps media, once per directory, named by the import's sidecar and the input manifest", async () => {
		const withMedia: string[] = [];
		const without: string[] = [];
		for (const entry of index?.documents ?? []) {
			const directory = join(root, "nova", entry.id);
			const manifest = JSON.parse(
				await readFile(join(directory, "inputs.json"), "utf8"),
			);
			const steps = [
				{ at: "export", name: "create", part: "a", role: "create.media" },
				{ at: "export", name: "republish", part: "b", role: "media" },
				...(entry.edit
					? [
							{
								at: "edit/export",
								name: "update",
								part: "b_edit",
								role: "media",
							},
						]
					: []),
			];
			for (const configuration of entry.configurations) {
				for (const step of steps) {
					const relativeDirectory = `${step.at}/${configuration}`;
					const exported = join(directory, relativeDirectory);
					const sidecar = JSON.parse(
						await readFile(join(exported, `${step.name}.json`), "utf8"),
					);
					const mapped = Object.keys(
						(await importedApp(exported, step.name)).multimedia_map ?? {},
					).sort();
					const roles = manifest.configurations[configuration][step.part];
					const where = `${entry.id} ${relativeDirectory}/${step.name}`;
					if (mapped.length === 0) {
						expect(sidecar.media, where).toBeUndefined();
						expect(roles[`${step.role}.body`], where).toBeUndefined();
						without.push(where);
						continue;
					}
					withMedia.push(where);
					expect(sidecar.media, where).toMatch(/^([a-z]+-)?media\.body$/);
					expect(roles[`${step.role}.body`]?.path, where).toBe(
						`${relativeDirectory}/${sidecar.media}`,
					);
					const base = sidecar.media.replace(/\.body$/, "");
					const upload = JSON.parse(
						await readFile(join(exported, `${base}.json`), "utf8"),
					);
					expect(upload, where).toMatchObject({
						method: "POST",
						path: "/a/nova-proof/apps/api/nova-proof-placeholder-app/multimedia/",
						fields: ["waf_padding", "bulk_upload_file"],
					});
					const zip = (
						await new Response(
							new Uint8Array(await readFile(join(exported, sidecar.media))),
							{ headers: { "content-type": upload.contentType } },
						).formData()
					).get("bulk_upload_file");
					if (!(zip instanceof File)) throw new Error(`${where} has no ZIP.`);
					// HQ matches each file to the app's references by its path
					// (`hqmedia/tasks.py::process_bulk_upload_zip`), so the ZIP
					// holds a file for exactly the paths the import maps.
					const files = new AdmZip(Buffer.from(await zip.arrayBuffer()))
						.getEntries()
						.filter((file) => !file.isDirectory)
						.map((file) => `jr://file/${file.entryName}`)
						.sort();
					expect(files, where).toEqual(mapped);
				}
				// The republish sends the create's media: one file holds it.
				const exported = join(directory, "export", configuration);
				const [create, republish] = await Promise.all(
					["create", "republish"].map(async (name) =>
						JSON.parse(await readFile(join(exported, `${name}.json`), "utf8")),
					),
				);
				expect(republish.media, entry.id).toBe(create.media);
			}
		}
		// This corpus has documents with media and documents without.
		expect(withMedia.length).toBeGreaterThan(0);
		expect(without.length).toBeGreaterThan(0);
	});

	it("names, per mutation kind, exactly the documents whose written batch was drawn for it, and the lane's floor refuses the kinds no fixed document carries before writing anything", async () => {
		const drawn = new Map<string, string>();
		for (const entry of index?.documents ?? []) {
			if (!entry.edit) continue;
			const batch = JSON.parse(
				await readFile(
					join(root, "nova", entry.id, "edit", "batch.json"),
					"utf8",
				),
			);
			drawn.set(entry.id, batch.intendedKind);
		}
		const fixedIds = new Set(fixed.map((document) => document.id));
		const landed = index?.census.fixed.landed;
		if (landed === undefined) throw new Error("The index holds no census.");
		for (const kind of EDIT_KINDS) {
			expect(landed[kind], kind).toEqual(
				[...drawn]
					.filter(([id, intended]) => fixedIds.has(id) && intended === kind)
					.map(([id]) => id),
			);
		}
		const unlanded = EDIT_KINDS.filter((kind) => landed[kind].length === 0);
		// A handful of documents carries a handful of kinds: some are missing.
		expect(unlanded.length).toBeGreaterThan(0);
		expect(unlanded.length).toBeLessThan(EDIT_KINDS.length);

		const out = join(root, "floor");
		const refused = await emit(out, fixed, sampled, {
			requireEveryKind: true,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(UnlandedKindsError);
		expect((refused as UnlandedKindsError).kinds).toEqual(unlanded);
		// Nothing was written: no index the checks would read, no document.
		expect(await readdir(out)).toEqual([]);
	});

	it("writes a targeted document with its own files and no edit, and changes no other document's batch by adding one", async () => {
		const targeted = lookupReservedTags();
		const out = join(root, "with-targeted");
		const withTargeted = await emit(out, [...fixed, targeted], []);
		const entry = withTargeted.index.documents.find(
			(document) => document.id === targeted.id,
		);
		expect(entry?.edit).toBe(false);
		expect(withTargeted.index.census.fixed.withoutEdit).not.toContain(
			targeted.id,
		);
		const written = await files(join(out, targeted.id));
		for (const [name, content] of Object.entries(targeted.files ?? {})) {
			expect(written.get(name)?.toString("utf8")).toBe(content);
		}
		expect(
			JSON.parse(written.get("expected.json")?.toString("utf8") ?? ""),
		).toEqual(targeted.expected);
		for (const document of index?.documents ?? []) {
			if (!fixed.some((fixedDocument) => fixedDocument.id === document.id)) {
				continue;
			}
			const batch = (corpus: string) =>
				readFile(join(corpus, document.id, "edit", "batch.json"), "utf8").then(
					(text) => text,
					() => undefined,
				);
			expect(await batch(out), document.id).toBe(
				await batch(join(root, "nova")),
			);
		}
	});

	it("writes a targeted document's written edit, its HQ-side saves and its project settings where the lane reads them", async () => {
		const saving = hqSideState();
		const syncing = syncOnFormEntry();
		const out = join(root, "with-hq-side");
		const emitted = await emit(out, [...fixed, saving, syncing], []);
		const entry = emitted.index.documents.find(
			(document) => document.id === saving.id,
		);
		expect(entry?.edit).toBe(true);
		const written = await files(join(out, saving.id));
		const batch = JSON.parse(
			written.get("edit/batch.json")?.toString("utf8") ?? "",
		);
		expect(batch.mutations).toEqual(
			JSON.parse(JSON.stringify(saving.edit?.mutations)),
		);
		expect(batch.intendedKind).toBe(saving.edit?.mutations[0]?.kind);
		expect(
			JSON.parse(written.get("hq-side.json")?.toString("utf8") ?? ""),
		).toEqual(saving.hqSide);
		const inputs = JSON.parse(
			written.get("inputs.json")?.toString("utf8") ?? "",
		);
		for (const parts of Object.values(inputs.configurations) as {
			a: Record<string, { path: string }>;
		}[]) {
			expect(parts.a.hqSide?.path).toBe("hq-side.json");
		}
		const configurations = (id: string) =>
			readFile(join(out, id, "configurations.json"), "utf8").then((text) =>
				JSON.parse(text),
			);
		const each = (held: {
			minimum: unknown;
			maximum: unknown;
			singleFlag: Record<string, unknown>;
		}) =>
			[held.minimum, held.maximum, ...Object.values(held.singleFlag)] as {
				syncCasesOnFormEntry: boolean;
				namedPrivileges: string[];
			}[];
		for (const configuration of each(await configurations(syncing.id))) {
			expect(configuration.syncCasesOnFormEntry).toBe(true);
		}
		for (const configuration of each(await configurations(saving.id))) {
			expect(configuration.syncCasesOnFormEntry).toBe(false);
			expect(configuration.namedPrivileges).toEqual(["BUILD_PROFILES"]);
		}
		expect((await files(join(out, syncing.id))).has("hq-side.json")).toBe(
			false,
		);
	});

	it("names in every configuration the privileges a document names, and none HQ would derive, at the harness's version", async () => {
		for (const entry of index?.documents ?? []) {
			const configurations = JSON.parse(
				await readFile(
					join(root, "nova", entry.id, "configurations.json"),
					"utf8",
				),
			);
			const named = entry.id === NAMING ? [NAMED_PRIVILEGE] : [];
			for (const configuration of [
				configurations.minimum,
				configurations.maximum,
				...Object.values(configurations.singleFlag),
			] as { namedPrivileges: string[]; commcareVersion: string }[]) {
				expect(configuration.namedPrivileges, entry.id).toEqual(named);
				expect(configuration).not.toHaveProperty("privileges");
				expect(configuration.commcareVersion).toBe(CORPUS_COMMCARE_VERSION);
			}
			expect(configurations.maximum.flags).toEqual(
				expect.arrayContaining(configurations.minimum.flags),
			);
		}
	});

	it("writes the same bytes on every run for a seed, minted identities included, and keeps defects 1 and 9 visible", {
		// Two more emissions of the corpus, each capturing every publish and
		// writing every archive: about a second on a laptop, and CI runners
		// are slower.
		timeout: 30_000,
	}, async () => {
		const runs: Map<string, Buffer>[] = [];
		// The runs happen at different times: whatever reads the clock must not reach the files.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (const [run, at] of [
				["first", "2026-03-01T00:00:00Z"],
				["second", "2027-06-15T12:34:56Z"],
			] as const) {
				vi.setSystemTime(new Date(at));
				await emit(join(root, run), fixed, sampled);
				runs.push(await files(join(root, run)));
			}
		} finally {
			vi.useRealTimers();
		}
		const nova = await files(join(root, "nova"));
		for (const run of runs) {
			expect([...run.keys()]).toEqual([...nova.keys()]);
			for (const [path, bytes] of nova) {
				// What each part took is the one file that varies.
				if (path === "timings.json") continue;
				expect(run.get(path)?.equals(bytes), path).toBe(true);
			}
		}
		expect(nova.has("inputs.json")).toBe(true);

		// Defect 1: the next publish of an unchanged document mints new ids.
		// Defect 9: so does the second local export, in its profile.
		const checked = ["arithmetic", "localization-mandarin"];
		for (const id of checked) {
			const directory = join(root, "nova", id, "export", "minimum");
			const created = await importedApp(directory, "create");
			const republished = await importedApp(directory, "republish");
			const ids = (app: ImportedApp) =>
				app.modules.flatMap((module) => [
					module.unique_id,
					...module.forms.flatMap((form) => [form.unique_id, form.xmlns]),
				]);
			const before = ids(created);
			const after = ids(republished);
			expect(before.length, id).toBeGreaterThan(1);
			expect(after).toHaveLength(before.length);
			expect(
				before.filter((value, at) => value === after[at]),
				id,
			).toEqual([]);
			const local = nova.get(`${id}/local.ccz`);
			const again = nova.get(`${id}/local-again.ccz`);
			if (local === undefined || again === undefined) {
				throw new Error(`${id} has no local archives.`);
			}
			const first = profileUniqueId(local);
			expect(first, id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(profileUniqueId(again), id).not.toBe(first);
		}
	});

	it("draws an update to D′ that sends anything but the republish from a stream of its own, and keeps one that sends the republish byte-identical", async () => {
		const minted = (app: ImportedApp) =>
			app.modules.flatMap((module) => [
				module.unique_id,
				...module.forms.flatMap((form) => [form.unique_id, form.xmlns]),
			]);
		const same: string[] = [];
		const changed: string[] = [];
		for (const entry of index?.documents ?? []) {
			if (!entry.edit) continue;
			for (const configuration of entry.configurations) {
				const directory = join(root, "nova", entry.id);
				const republished = join(directory, "export", configuration);
				const updated = join(directory, "edit", "export", configuration);
				const bodies = await Promise.all([
					readFile(join(republished, "republish.body")),
					readFile(join(updated, "update.body")),
				]);
				const name = `${entry.id} ${configuration}`;
				if (bodies[0].equals(bodies[1])) {
					same.push(name);
					continue;
				}
				changed.push(name);
				const before = new Set(
					minted(await importedApp(republished, "republish")),
				);
				const after = minted(await importedApp(updated, "update"));
				expect(after.length, name).toBeGreaterThan(0);
				expect(
					after.filter((value) => before.has(value)),
					name,
				).toEqual([]);
			}
		}
		// Both kinds of edit are in this corpus, so both halves were held.
		expect(same.length).toBeGreaterThan(0);
		expect(changed.length).toBeGreaterThan(0);
	});

	it("writes the same documents from worker processes as from its own process", {
		// Three worker processes each load Nova's modules through tsx before
		// writing (about 3 s on a laptop); CI runners are slower.
		timeout: 60_000,
	}, async () => {
		// Enough documents that the emitter starts three workers, spanning
		// the producer families.
		const spread = producers.filter((_, index) => index % 6 === 0).slice(0, 24);
		expect(spread).toHaveLength(24);
		const here = await emit(join(root, "spread-here"), spread, []);
		const workers = await emit(join(root, "spread-workers"), spread, [], {
			jobs: 3,
		});
		expect(here.timings.jobs).toBe(1);
		expect(workers.timings.jobs).toBe(3);
		expect(workers.index.documents).toEqual(here.index.documents);
		// Each export draws from its own operation's generator, whichever
		// process makes it and whatever it made before: every file matches.
		const inProcess = await files(join(root, "spread-here"));
		const fromWorkers = await files(join(root, "spread-workers"));
		expect([...fromWorkers.keys()]).toEqual([...inProcess.keys()]);
		for (const [path, bytes] of inProcess) {
			if (path === "timings.json") continue;
			expect(fromWorkers.get(path)?.equals(bytes), path).toBe(true);
		}

		// A selection writes its documents exactly as the whole corpus does,
		// though their neighbours in each process are others.
		const chosen = [spread[5]?.id, spread[17]?.id].filter(
			(id): id is string => id !== undefined,
		);
		const selected = await emit(join(root, "spread-selected"), spread, [], {
			only: chosen,
		});
		expect(selected.index.documents.map((entry) => entry.id)).toEqual(chosen);
		expect(selected.index.selection).toBe("chosen");
		const written = await files(join(root, "spread-selected"));
		const perDocument = [...written.keys()].filter((path) =>
			chosen.some((id) => path.startsWith(`${id}/`)),
		);
		expect(perDocument.length).toBeGreaterThan(10);
		for (const path of perDocument) {
			expect(
				written.get(path)?.equals(inProcess.get(path) ?? Buffer.alloc(0)),
				path,
			).toBe(true);
		}
	});
});
