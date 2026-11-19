/**
 * The corpus emitter writes only admitted documents, and writes them the
 * same way, byte for byte, on every run for a seed.
 *
 * Contract: every document `emitCorpus` writes (D in `document.json`, D′ in
 * `edit/document.json`) is one Nova's stores hold and admit (the strict
 * schema and full validation, read back from the files the checks read); a
 * document Nova's publish refuses is left out and named with the boundary's
 * findings; and two emissions of one corpus at one seed are byte-identical
 * file for file, whatever the time, the
 * process that writes a document, or which other documents are written
 * with it (`./entropy.mts` seeds each export by the corpus seed, its
 * ordinal and its configuration). The plausible failures: a written
 * document that no Nova store would hold (a hydrated field left in, a lookup
 * cell or upload the store would refuse), an edited document the commit
 * gate never admitted, a refused document slipping into the corpus, and a
 * source of variation (a clock, an unordered collection, a random boundary,
 * a draw made outside its operation or shared between two) making every
 * comparison over the corpus noisy and no observation reusable. Seeding must
 * shape no id an export carries. The republish carries the first publish's
 * module and form ids and `xmlns`; an update to D′ that changes nothing
 * Nova sends is byte-identical to the republish; and a document's two local
 * exports are one archive, byte for byte. The two of each pair are drawn in
 * streams of their own, so a change that mints an id per export again fails
 * here.
 *
 * A first publish is two imports: the empty shell's create, which names
 * neither a workbook nor media, and the content update that fills it. A
 * publish whose export carries media sends it after its content import
 * (`lib/deployment/service.ts::uploadMediaBytes`), and the HQ side replays
 * that upload, so its capture must be written beside the import, named by
 * the import's sidecar and by the input manifest. The plausible failures: a
 * document whose export carries media with no upload written (HQ's app
 * would reference media it never stores), an upload that carries other
 * files than the export's prepared assets, a shell that names media, and a
 * document without media gaining any file or role (its records would
 * change). The observation is the export's prepared assets (the paths
 * `buildMediaBulkUploadZip` writes) beside the written upload.
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
 * A document whose project space has CommCare Supply on while its verdict
 * asks it off stands in a configuration Nova refuses, and is refused; one
 * whose verdict says nothing keeps the setting in every configuration. The
 * plausible failures are a refusal that reads the setting alone, refusing a
 * document Nova publishes there, and one that never reads the verdict.
 *
 * A document whose saves in HQ the republish brings in is written as the
 * document that republish sends: `document.json` holds the document the
 * bring-in gave, and its local archives install exactly the forms the
 * republish sends, under the `xmlns` the bring-in read of HQ's app. The
 * plausible failures are a document and an archive of D, which the lane
 * would compare with A after the saves (an app that holds the person's
 * change against one that does not), and an archive under the derived ids,
 * whose added form is not the one HQ holds. The observation is the written
 * files beside the captured republish.
 *
 * The lane's emission holds the fixed floor's census to
 * `proof/corpus/left-out.json` (`leftOutDifferences`) and stops before
 * writing anything where they differ. The plausible failures: a rule that
 * newly refuses a fixed document making the corpus one document smaller and
 * passing, and a list that keeps naming a document the corpus takes. The
 * observation is this suite's own census against three lists: one naming
 * the document it refuses, an empty one and one naming a document it takes;
 * and the committed list read by its own schema.
 *
 * The corpus here is small but spans what the emitter treats differently:
 * producer documents with lookup data and uploaded media, three languages
 * whose wire codes are not their tags, a workforce document over a producer
 * document with media, one document Nova's publish refuses, and two fuzz
 * draws with their generated media.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { isTag } from "domhandler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { manifestFor } from "@/lib/commcare/__tests__/compilerEvidence";
import { profileUniqueId as derivedUniqueId } from "@/lib/commcare/runtimeTarget";
import { runValidation } from "@/lib/commcare/validator/runner";
import { parseXml } from "@/lib/commcare/xmlParse";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, effectiveAppLocalization } from "@/lib/domain";
import { commtrackAdvanced } from "../../targeted/documents/advancedModules";
import { hqChangesForms } from "../../targeted/documents/hqChanges";
import { hqSideState } from "../../targeted/documents/hqSideState";
import { lookupReservedTags } from "../../targeted/documents/lookupReservedTags";
import { sameTypeChild } from "../../targeted/documents/sameTypeChild";
import {
	syncOnFormEntry,
	syncOnFormEntryWebApps,
} from "../../targeted/documents/searchApps";
import { CORPUS_COMMCARE_VERSION } from "../configurations";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { type CorpusDocument, lookupContextOf } from "../documents";
import { EDIT_KINDS } from "../editBatches";
import { WORKTREE } from "../emissionProcess";
import {
	type EmittedCorpus,
	emitCorpus,
	type LeftOut,
	LeftOutError,
	leftOutDifferences,
	leftOutMessage,
	leftOutSchema,
	UnlandedKindsError,
} from "../emitCorpus";
import { sampleFuzzDocuments } from "../fuzzSample";
import { hqAuthoredDocuments } from "../hqAuthored";
import { producerDocuments } from "../producers";
import {
	documentVerdict,
	PLACEHOLDER_APP_ID,
	PROOF_DOMAIN,
	PROOF_SERVER,
	preparedMediaPaths,
} from "../publish";
import { workforceDocumentId, workforceDocuments } from "../workforce";
import { readDocuments } from "../writePublishCaptures";
import {
	CONTROLLED_BASE,
	CONTROLLED_EXPECTATION,
	CONTROLLED_RESTORE,
	writeControlledBase,
} from "./controlledBase";

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
const LEFT_OUT_FILE = join(WORKTREE, "proof", "corpus", "left-out.json");
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

/*
 * Budgets, each several times what the work takes alone on a hosted runner's
 * four cores, since a batch that shares the cores runs it several times
 * slower. Alone, the suite's own emission of the fixed floor and the sample
 * takes 20 to 45 s, most of it the ten sampled documents; an emission of the
 * fixed floor 3 to 13 s; a pass over every emitted document's files under
 * 1.5 s.
 */
const SUITE_EMISSION_MS = 180_000;
const EMISSION_MS = 120_000;
const FILES_PASS_MS = 30_000;

interface ImportedApp {
	readonly langs: string[];
	readonly multimedia_map?: unknown;
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

/** The `xmlns` of each form a local archive installs: its main instance's root, read from each parsed form. */
function archiveFormXmlns(archive: Buffer): Set<string> {
	const found = new Set<string>();
	for (const entry of new AdmZip(archive).getEntries()) {
		if (!/^modules-\d+\/forms-\d+\.xml$/.test(entry.entryName)) continue;
		const pending = [...parseXml(entry.getData().toString("utf8")).children];
		while (pending.length > 0) {
			const node = pending.shift();
			if (node === undefined || !isTag(node)) continue;
			if (node.name === "instance" && node.attribs.id === undefined) {
				const root = node.children.find(isTag);
				if (root?.attribs.xmlns !== undefined) found.add(root.attribs.xmlns);
				continue;
			}
			pending.push(...node.children);
		}
	}
	return found;
}

async function emit(
	out: string,
	fixed: readonly CorpusDocument[],
	sampled: readonly CorpusDocument[],
	options: {
		readonly jobs?: number;
		readonly requireEveryKind?: boolean;
		readonly only?: readonly string[];
		readonly leftOut?: LeftOut;
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
		...(options.leftOut !== undefined && { leftOut: options.leftOut }),
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
		// The advanced family's draws are documents like the others to the
		// emitter; this suite's corpus keeps to the two original draws and the
		// expression family, and the fuzz sample's own suite holds the family.
		sampled = sampleFuzzDocuments({
			size: 2,
			seed: DEFAULT_CORPUS_SEED,
			manifestFor,
		})
			.filter((sample) => sample.generator !== "advanced")
			.map((sample) => sample.document);
		({ index } = await emit(join(root, "nova"), fixed, sampled));
		// The hook compiles and gates every document this suite reads.
	}, SUITE_EMISSION_MS);

	afterAll(async () => {
		vi.useRealTimers();
		await rm(root, { recursive: true, force: true });
	});

	/*
	 * The fixed floor with targeted documents beside it: one with its own files
	 * and no edit, one with a written edit and HQ-side saves, and one that
	 * syncs cases on form entry. One emission holds all three, made once for
	 * the two tests that read it.
	 */
	const targeted = lookupReservedTags();
	const saving = hqSideState();
	const syncing = syncOnFormEntryWebApps();
	const withTargetedOut = () => join(root, "with-targeted");
	let withTargeted: Promise<EmittedCorpus> | undefined;
	const emittedWithTargeted = () => {
		withTargeted ??= emit(
			withTargetedOut(),
			[...fixed, targeted, saving, syncing],
			[],
		);
		return withTargeted;
	};

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

	it("writes documents, and edited documents, that Nova's stores hold and admit", {
		timeout: FILES_PASS_MS,
	}, async () => {
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

	it("places each document's languages on the wire in the order and with the codes of the langs its imports send", {
		timeout: FILES_PASS_MS,
	}, async () => {
		const multilingual: string[] = [];
		for (const entry of index?.documents ?? []) {
			const directory = join(root, "nova", entry.id);
			const sides = [
				{ root: directory, step: "create", imports: ["create", "content"] },
				...(entry.edit
					? [
							{
								root: join(directory, "edit"),
								step: "update",
								imports: ["update"],
							},
						]
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
					for (const name of side.imports) {
						const app = await importedApp(
							join(side.root, "export", configuration),
							name,
						);
						expect(
							languages.map((language) => language.code),
							`${entry.id} ${name} ${configuration}`,
						).toEqual(app.langs);
					}
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

	it("writes the media upload each publish sends after its content import, exactly the assets the bulk upload carries, once per directory, named by the import's sidecar and the input manifest", {
		timeout: FILES_PASS_MS,
	}, async () => {
		const withMedia: string[] = [];
		const without: string[] = [];
		for (const entry of index?.documents ?? []) {
			const directory = join(root, "nova", entry.id);
			const manifest = JSON.parse(
				await readFile(join(directory, "inputs.json"), "utf8"),
			);
			const [stored] = readDocuments([
				JSON.parse(await readFile(join(directory, "document.json"), "utf8")),
			]);
			const [edited] = entry.edit
				? readDocuments([
						JSON.parse(
							await readFile(join(directory, "edit", "document.json"), "utf8"),
						),
					])
				: [];
			if (stored === undefined) throw new Error(`${entry.id} read as nothing.`);
			const paths = await preparedMediaPaths(stored.document, PROOF_DOMAIN);
			const steps = [
				{
					at: "export",
					name: "content",
					part: "a",
					role: "content.media",
					paths,
				},
				{ at: "export", name: "republish", part: "b", role: "media", paths },
				...(edited !== undefined
					? [
							{
								at: "edit/export",
								name: "update",
								part: "b_edit",
								role: "media",
								paths: await preparedMediaPaths(edited.document, PROOF_DOMAIN),
							},
						]
					: []),
			];
			for (const configuration of entry.configurations) {
				// The shell names no media, and no workbook either.
				const shell = JSON.parse(
					await readFile(
						join(directory, "export", configuration, "create.json"),
						"utf8",
					),
				);
				expect(shell.layout, entry.id).toBe(2);
				expect(shell.media, entry.id).toBeUndefined();
				expect(shell.lookups, entry.id).toBeUndefined();
				expect(
					manifest.configurations[configuration].a["create.media.body"],
					entry.id,
				).toBeUndefined();
				for (const step of steps) {
					const relativeDirectory = `${step.at}/${configuration}`;
					const exported = join(directory, relativeDirectory);
					const sidecar = JSON.parse(
						await readFile(join(exported, `${step.name}.json`), "utf8"),
					);
					const app = await importedApp(exported, step.name);
					const roles = manifest.configurations[configuration][step.part];
					const where = `${entry.id} ${relativeDirectory}/${step.name}`;
					expect(app, where).not.toHaveProperty("multimedia_map");
					if (step.paths.length === 0) {
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
					// holds a file at exactly each prepared asset's wire path.
					const files = new AdmZip(Buffer.from(await zip.arrayBuffer()))
						.getEntries()
						.filter((file) => !file.isDirectory)
						.map((file) => file.entryName)
						.sort();
					expect(files, where).toEqual(step.paths);
				}
				// The republish sends the content's media: one file holds it.
				const exported = join(directory, "export", configuration);
				const [content, republish] = await Promise.all(
					["content", "republish"].map(async (name) =>
						JSON.parse(await readFile(join(exported, `${name}.json`), "utf8")),
					),
				);
				expect(republish.media, entry.id).toBe(content.media);
			}
		}
		// This corpus has documents with media and documents without.
		expect(withMedia.length).toBeGreaterThan(0);
		expect(without.length).toBeGreaterThan(0);
	});

	it("names, per mutation kind, exactly the documents whose written batch was drawn for it, and the lane's floor refuses the kinds no fixed document carries before writing anything", {
		// The refused emission plans every document's batch before it stops.
		timeout: EMISSION_MS,
	}, async () => {
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

	it("holds the fixed floor's census to what left-out.json names, and stops before writing anything where a document leaves or joins", async () => {
		const census = index?.census.fixed;
		if (census === undefined) throw new Error("The index holds no census.");
		const refusedEntry = {
			id: REFUSED,
			by: "publish",
			codes: ["HQ_NESTED_SELECTION_UNREPRESENTABLE"],
		} as const;
		expect(
			leftOutDifferences(census, { documents: [refusedEntry], edits: [] }),
		).toEqual([]);

		const unseen = leftOutDifferences(census, { documents: [], edits: [] });
		expect(unseen).toEqual([
			{ change: "leaves", part: "document", entry: refusedEntry },
		]);
		expect(unseen.map(leftOutMessage)).toEqual([
			`The corpus now leaves out ${REFUSED}: Nova's publish refuses it (HQ_NESTED_SELECTION_UNREPRESENTABLE). The fixed corpus leaves out only what proof/corpus/left-out.json names, so a rule that refuses more can't shrink it unseen. If the rule is right, change the document's source so it holds what Nova holds, or name it in left-out.json. If it isn't, the rule refuses too much.`,
		]);

		const takenEntry = {
			id: PRODUCER_IDS[0] ?? "",
			by: "publish",
			codes: ["HQ_NESTED_SELECTION_UNREPRESENTABLE"],
		} as const;
		const taken = leftOutDifferences(census, {
			documents: [takenEntry, refusedEntry],
			edits: [],
		});
		expect(taken).toEqual([
			{ change: "takes", part: "document", entry: takenEntry },
		]);
		expect(taken.map(leftOutMessage)).toEqual([
			`proof/corpus/left-out.json names ${takenEntry.id} as left out, and the corpus now takes it. Take it off the list.`,
		]);

		const refusedDocument = fixed.find((document) => document.id === REFUSED);
		if (refusedDocument === undefined)
			throw new Error(`The fixed floor holds no ${REFUSED}.`);
		const out = join(root, "left-out");
		const stopped = await emit(out, [refusedDocument], [], {
			leftOut: { documents: [], edits: [] },
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(stopped).toBeInstanceOf(LeftOutError);
		expect((stopped as LeftOutError).differences).toEqual(unseen);
		// Nothing was written: no index the checks would read, no document.
		expect(await readdir(out)).toEqual([]);
	});

	it("reads the committed left-out.json as one list of documents and one of edits, each in id order", async () => {
		const committed = leftOutSchema.safeParse(
			JSON.parse(await readFile(LEFT_OUT_FILE, "utf8")),
		);
		expect(committed.success, committed.error?.message).toBe(true);
		const unordered = leftOutSchema.safeParse({
			documents: [
				{ id: "b", by: "publish", codes: ["A"] },
				{ id: "a", by: "publish", codes: ["A"] },
			],
			edits: [],
		});
		expect(unordered.success).toBe(false);
	});

	it("writes a targeted document with its own files and no edit, and changes no other document's batch by adding targeted documents", {
		// Another emission of every fixed document, capturing each publish.
		timeout: EMISSION_MS,
	}, async () => {
		const out = withTargetedOut();
		const withTargeted = await emittedWithTargeted();
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

	it("writes a targeted document's written edit, its HQ-side saves and its project settings where the lane reads them", {
		// The emission the test above reads, made here where this test runs alone.
		timeout: EMISSION_MS,
	}, async () => {
		const out = withTargetedOut();
		const emitted = await emittedWithTargeted();
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

	it("writes the document a bring-in of a person's saves gave, and its local archive under the ids the bring-in read, where the republish sends it", {
		timeout: 60_000,
	}, async () => {
		const forms = hqChangesForms();
		const out = join(root, "brings-in");
		await emit(out, [forms], []);
		const written = await files(join(out, forms.id));
		const document = JSON.parse(
			written.get("document.json")?.toString("utf8") ?? "",
		);
		expect(document.doc).toEqual(
			JSON.parse(JSON.stringify(forms.hqSide?.bringsIn)),
		);
		const republished = await importedApp(
			join(out, forms.id, "export", "minimum"),
			"republish",
		);
		const sent = new Set(
			republished.modules.flatMap((module) =>
				module.forms.map((form) => form.xmlns),
			),
		);
		const local = written.get("local.ccz");
		if (local === undefined) throw new Error(`${forms.id} has no local.ccz.`);
		expect(archiveFormXmlns(local)).toEqual(sent);
		expect(written.get("local-again.ccz")?.equals(local)).toBe(true);
	});

	it("refuses a document that turns sync on form entry on while its publish asks that it be off", async () => {
		const refused: CorpusDocument = {
			...syncOnFormEntry(),
			projectSettings: { syncCasesOnFormEntry: true },
		};
		await expect(
			emit(join(root, "sync-on-refused"), [refused], []),
		).rejects.toThrow(
			`${refused.id} turns sync on form entry on, and Nova's publish asks the person to confirm it is off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
		);
	});

	it("refuses CommCare Supply on where the verdict asks it off, and keeps it on for a document whose verdict says nothing", {
		timeout: FILES_PASS_MS,
	}, async () => {
		const arithmetic = producers.find(
			(document) => document.id === "arithmetic",
		);
		if (arithmetic === undefined) {
			throw new Error("The producers emit no document arithmetic.");
		}
		const supplied: CorpusDocument = {
			...arithmetic,
			projectSettings: { commtrack: true },
		};
		// An advanced menu whose case list is its own menu item asks CommCare
		// Supply off.
		const refused: CorpusDocument = {
			...commtrackAdvanced(),
			projectSettings: { commtrack: true },
		};
		await expect(
			emit(join(root, "supply-on-refused"), [refused], []),
		).rejects.toThrow(
			`${refused.id} turns CommCare Supply on, and Nova's publish asks the person to confirm it is off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
		);
		const out = join(root, "supply-on-kept");
		await emit(out, [supplied], []);
		const verdict = JSON.parse(
			await readFile(join(out, supplied.id, "verdict.json"), "utf8"),
		);
		expect(verdict.minimumConfiguration).not.toHaveProperty("commtrackEnabled");
		const configurations = JSON.parse(
			await readFile(join(out, supplied.id, "configurations.json"), "utf8"),
		);
		for (const configuration of [
			configurations.minimum,
			configurations.maximum,
			...Object.values(configurations.singleFlag),
		] as { commtrack: boolean }[]) {
			expect(configuration.commtrack).toBe(true);
		}
	});

	it("refuses a configuration that turns on a flag the verdict needs off, and writes the document's own configurations without it", {
		timeout: FILES_PASS_MS,
	}, async () => {
		const document = sameTypeChild();
		const refused: CorpusDocument = {
			...document,
			singleFlags: ["DONT_INDEX_SAME_CASETYPE"],
		};
		await expect(
			emit(join(root, "flag-off-refused"), [refused], []),
		).rejects.toThrow(
			`${refused.id} turns DONT_INDEX_SAME_CASETYPE on in its DONT_INDEX_SAME_CASETYPE configuration, and Nova's publish requires that flag off for this document, so its configuration is one Nova refuses; a check runs only against a target Nova's publish accepts (decision 19).`,
		);
		const out = join(root, "flag-off-kept");
		await emit(out, [document], []);
		const verdict = JSON.parse(
			await readFile(join(out, document.id, "verdict.json"), "utf8"),
		);
		expect(verdict.minimumConfiguration.flagsOff).toEqual([
			"DONT_INDEX_SAME_CASETYPE",
		]);
		const configurations = JSON.parse(
			await readFile(join(out, document.id, "configurations.json"), "utf8"),
		);
		for (const configuration of [
			configurations.minimum,
			configurations.maximum,
			...Object.values(configurations.singleFlag),
		] as { flags: string[] }[]) {
			expect(configuration.flags).not.toContain("DONT_INDEX_SAME_CASETYPE");
		}
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

	it("writes the same bytes on every run for a seed, sends the first publish's ids on the republish, and writes a document's two local exports as one archive", {
		// One more emission of the whole corpus, capturing every publish and
		// writing every archive, as long again as the suite's own.
		timeout: SUITE_EMISSION_MS,
	}, async () => {
		// The run happens at another time than the suite's own, which reads the
		// real clock: whatever reads the clock must not reach the files.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.setSystemTime(new Date("2027-06-15T12:34:56Z"));
			await emit(join(root, "again"), fixed, sampled);
		} finally {
			vi.useRealTimers();
		}
		const run = await files(join(root, "again"));
		const nova = await files(join(root, "nova"));
		expect([...run.keys()]).toEqual([...nova.keys()]);
		for (const [path, bytes] of nova) {
			// What each part took is the one file that varies.
			if (path === "timings.json") continue;
			expect(run.get(path)?.equals(bytes), path).toBe(true);
		}
		expect(nova.has("inputs.json")).toBe(true);

		// The next publish of an unchanged document sends the ids the first sent.
		// A document's two local exports are one archive: the profile's `uniqueid` is derived from the app's id and the project space.
		const checked = ["arithmetic", "localization-mandarin"];
		for (const id of checked) {
			const directory = join(root, "nova", id, "export", "minimum");
			const created = await importedApp(directory, "content");
			const republished = await importedApp(directory, "republish");
			const ids = (app: ImportedApp) =>
				app.modules.flatMap((module) => [
					module.unique_id,
					...module.forms.flatMap((form) => [form.unique_id, form.xmlns]),
				]);
			const before = ids(created);
			const after = ids(republished);
			expect(before.length, id).toBeGreaterThan(1);
			expect(after, id).toEqual(before);
			expect(nova.has(`${id}/import-file.zip`), id).toBe(true);
			const local = nova.get(`${id}/local.ccz`);
			const again = nova.get(`${id}/local-again.ccz`);
			if (local === undefined || again === undefined) {
				throw new Error(`${id} has no local archives.`);
			}
			const document = JSON.parse(
				(nova.get(`${id}/document.json`) ?? Buffer.alloc(0)).toString("utf-8"),
			) as { readonly doc: { readonly appId: string } };
			const derived = derivedUniqueId(document.doc.appId, {
				server: PROOF_SERVER,
				domain: PROOF_DOMAIN,
				appId: PLACEHOLDER_APP_ID,
			});
			expect(profileUniqueId(local), id).toBe(derived);
			expect(profileUniqueId(again), id).toBe(derived);
			expect(local.equals(again), id).toBe(true);
		}
	});

	it("sends an update to D′ that changes nothing Nova sends as the republish's bytes, each drawn in a stream of its own", async () => {
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
			}
		}
		// Both kinds of edit are in this corpus, so both halves were held.
		expect(same.length).toBeGreaterThan(0);
		expect(changed.length).toBeGreaterThan(0);
	});

	it("writes the same documents from worker processes as from its own process", {
		// Three emissions of seventeen documents, one in three worker processes
		// that each load Nova's modules through tsx before writing: 23 to 39 s
		// alone.
		timeout: SUITE_EMISSION_MS,
	}, async () => {
		// The fewest documents for which the emitter starts three workers (it
		// gives each at most eight), spanning the producer families.
		const step = Math.floor(producers.length / 17);
		const spread = producers
			.filter((_, index) => index % step === 0)
			.slice(0, 17);
		expect(spread).toHaveLength(17);
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
		const chosen = [spread[5]?.id, spread[13]?.id].filter(
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

/*
 * A document made in CommCare HQ (`hq-authored`), emitted over a base
 * directory laid out as `proof/hq-apps/<base>/` lays one out and made of
 * HQ's own retained answers (`./controlledBase.ts`): the base's first
 * reading, Nova's publish over its A as over an app Nova brought in, and
 * the files the lane makes A and judges the hop from.
 *
 * Contract: two emissions of the source at one seed are byte-identical file
 * for file; the document's directory holds what its A is made of under
 * `authored/` (the base's bytes), its one configuration from `base.json` as
 * both `minimum` and `maximum`, `export/minimum/` alone with no first
 * publish, the republish sending A's own menu and form ids and `xmlns`,
 * `document.json`'s `hqAuthored` as a read back reads it, the first-publish
 * ids, and each hand-written value expectation once a state it runs at with
 * its form resolved to D's and its restore beside it; and a document that
 * names saves in HQ over A is refused. The plausible failures: a reading or
 * a capture that draws (an id minted per run), a body carrying a derived id
 * where A holds HQ's, a first publish written over an A Nova never sent,
 * a configuration the base was not authored under, a file of A left out of
 * the document's key, and an expectation run on a form other than the one a
 * person named.
 */
describe("the hq-authored source", () => {
	let scratch: string;
	let document: CorpusDocument;
	let first: Map<string, Buffer>;
	let second: Map<string, Buffer>;
	let base: string;

	beforeAll(async () => {
		scratch = await mkdtemp(join(tmpdir(), "nova-hq-authored-"));
		const root = join(scratch, "hq-apps");
		const hand = join(scratch, "hand");
		await writeControlledBase(root, hand);
		/* The base is authored under the flags its content needs, as every
		 * base is (`proof/matrix/registry.py`). */
		const {
			documents: [read],
		} = await hqAuthoredDocuments(root, hand);
		if (read === undefined)
			throw new Error("The controlled base read to none.");
		const { flags } = documentVerdict({
			id: read.id,
			doc: read.doc,
			compiledAtSeq: 1,
			...(read.media !== undefined && { media: read.media }),
		}).minimumConfiguration;
		base = await writeControlledBase(root, hand, flags);
		const {
			documents: [authored],
		} = await hqAuthoredDocuments(root, hand);
		if (authored === undefined)
			throw new Error("The controlled base read to none.");
		document = authored;
		await emit(join(scratch, "first"), [document], []);
		await emit(join(scratch, "second"), [document], []);
		first = await files(join(scratch, "first"));
		second = await files(join(scratch, "second"));
	}, 240_000);

	afterAll(async () => {
		await rm(scratch, { recursive: true, force: true });
	});

	const at = (path: string) => {
		const bytes = first.get(`${CONTROLLED_BASE}/${path}`);
		if (bytes === undefined)
			throw new Error(`The emission wrote no ${CONTROLLED_BASE}/${path}.`);
		return bytes;
	};
	const json = (path: string) => JSON.parse(at(path).toString("utf8"));

	it("writes the same bytes on every run for a seed", () => {
		expect([...second.keys()]).toEqual([...first.keys()]);
		for (const [path, bytes] of first) {
			if (path === "timings.json") continue;
			expect(second.get(path)?.equals(bytes), path).toBe(true);
		}
	});

	it("copies what A is made of into authored/, under the base's one configuration, with no first publish", async () => {
		for (const name of ["app.json", "seed.json"]) {
			expect(
				at(`authored/${name}`).equals(await readFile(join(base, name))),
				name,
			).toBe(true);
		}
		const configurations = json("configurations.json");
		const authored = JSON.parse(
			await readFile(join(base, "base.json"), "utf8"),
		).configuration;
		expect(configurations).toEqual({
			minimum: authored,
			maximum: authored,
			singleFlag: {},
		});
		const exported = [...first.keys()].filter((path) =>
			path.startsWith(`${CONTROLLED_BASE}/export/`),
		);
		expect(new Set(exported.map((path) => path.split("/")[2]))).toEqual(
			new Set(["minimum"]),
		);
		expect(exported.some((path) => /\/(create|content)\./.test(path))).toBe(
			false,
		);
		expect(json("export/minimum/outcome.json")).toMatchObject({
			republish: { status: "sent" },
		});
		expect(json("export/minimum/outcome.json").create).toBeUndefined();
		const index = JSON.parse(
			(first.get("index.json") ?? Buffer.alloc(0)).toString("utf8"),
		);
		expect(index.documents).toEqual([
			{
				id: CONTROLLED_BASE,
				source: `hq-authored:${CONTROLLED_BASE}`,
				group: CONTROLLED_BASE,
				edit: false,
				configurations: ["minimum"],
			},
		]);
		const inputs = json("inputs.json");
		expect(Object.keys(inputs.configurations.minimum.a)).toEqual(
			expect.arrayContaining([
				"authored.app",
				"seed",
				"privileges.authored.app",
				"privileges.republish.request.body",
			]),
		);
		expect(
			inputs.configurations.minimum.a["create.request.body"],
		).toBeUndefined();
		expect(inputs.judge.firstPublish).toEqual({
			path: "first-publish.json",
			digest: expect.stringMatching(/^sha256:/),
		});
	});

	it("republishes A under A's own menu and form ids and xmlns", async () => {
		const source = JSON.parse(
			JSON.parse(await readFile(join(base, "app-source.json"), "utf8")).body,
		) as ImportedApp;
		const sent = await importedApp(
			join(scratch, "first", CONTROLLED_BASE, "export", "minimum"),
			"republish",
		);
		expect(sent.modules.map((module) => module.unique_id)).toEqual(
			source.modules.map((module) => module.unique_id),
		);
		expect(
			sent.modules.map((module) => module.forms.map((form) => form.xmlns)),
		).toEqual(
			source.modules.map((module) => module.forms.map((form) => form.xmlns)),
		);
	});

	it("writes the reading's facts where a read back reads them, and the first-publish ids", () => {
		const facts = document.hqAuthored;
		if (facts === undefined) throw new Error("The document holds no facts.");
		expect(json("document.json").hqAuthored).toEqual({
			identity: facts.identity,
			declaration: facts.declaration,
			firstPublish: facts.firstPublish,
			mediaPaths: {},
		});
		expect(json("first-publish.json")).toEqual({ ids: facts.firstPublish });
	});

	it("writes each hand-written expectation once a state it runs at, on the form a person named, with its restore", () => {
		const facts = document.hqAuthored;
		if (facts === undefined) throw new Error("The document holds no facts.");
		const source = facts.source as ImportedApp;
		const xmlns = source.modules[0]?.forms[0]?.xmlns;
		const form = facts.identity.find(
			(row) => row.entityKind === "form" && row.xmlns === xmlns,
		)?.novaEntityUuid;
		expect(form).toBeDefined();
		const states =
			facts.declaration.runsOnlyOn === "web-apps"
				? ["A", "B"]
				: ["A", "B", "local"];
		expect(json("expected.json")).toEqual({
			intent: states.map((state) => ({
				id: `${CONTROLLED_EXPECTATION.id}@${state}`,
				export: state,
				form,
				restore: CONTROLLED_EXPECTATION.restore,
				request: CONTROLLED_EXPECTATION.request,
				expect: CONTROLLED_EXPECTATION.expect,
			})),
		});
		expect(at("restore.xml").toString("utf8")).toBe(CONTROLLED_RESTORE);
	});

	it("refuses a hand-written expectation that opens a case list on A or B, which the lane's evaluate opens only on the local archive", async () => {
		const path = join(scratch, "hand", CONTROLLED_BASE, "expectations.json");
		const kept = await readFile(path, "utf8");
		const listed = {
			...CONTROLLED_EXPECTATION,
			id: "registration-list",
			request: { session: { command: "m0-f0" }, caseList: {} },
			expect: [{ pointer: "/caseList/headers/0", value: "Name" }],
		};
		try {
			await writeFile(path, JSON.stringify([listed]));
			await expect(
				emit(join(scratch, "case-list-on-a"), [document], []),
			).rejects.toThrow(
				/registration-list of navigation-base opens a case list on A and B/,
			);
			await writeFile(
				path,
				JSON.stringify([{ ...listed, exports: ["B", "local"] }]),
			);
			await expect(
				emit(join(scratch, "case-list-on-b"), [document], []),
			).rejects.toThrow(/opens a case list on B, and/);
			await writeFile(
				path,
				JSON.stringify([{ ...listed, exports: ["local"] }]),
			);
			await emit(join(scratch, "case-list-local"), [document], []);
			const written = JSON.parse(
				await readFile(
					join(scratch, "case-list-local", CONTROLLED_BASE, "expected.json"),
					"utf8",
				),
			);
			expect(
				written.intent.map((one: { readonly id: string }) => one.id),
			).toEqual(
				document.hqAuthored?.declaration.runsOnlyOn === "web-apps"
					? []
					: ["registration-list@local"],
			);
		} finally {
			await writeFile(path, kept);
		}
	});

	it("refuses a document made in CommCare HQ that names saves in HQ over A", async () => {
		await expect(
			emit(
				join(scratch, "refused"),
				[{ ...document, hqSide: { republish: "proceeds" } }],
				[],
			),
		).rejects.toThrow(/names saves a person makes in HQ over A/);
	});
});
