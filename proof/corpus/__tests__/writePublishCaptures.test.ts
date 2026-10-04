/**
 * The capture writer's output is the same, byte for byte, on every run for
 * a seed, and it keeps the identities Nova mints apart where Nova does.
 *
 * Contract: `writePublishCaptures` writes, for each document and
 * configuration, the files the HQ side of the harness reads, each export's
 * minted identities (`lib/commcare/ids.ts` for module and form `unique_id`s
 * and form `xmlns`, `randomUUID` for a `.ccz` profile's `uniqueid`) drawn
 * from its operation's seeded generator (`../entropy.mts`). The plausible
 * failures: a source of variation reaching the files (a draw left unseeded,
 * a multipart boundary, an archive timestamp or zone, an unordered
 * collection), which would make every comparison over them noisy; the
 * minted identities collapsing, which would hide defects 1 and 9 from the
 * checks that must see them (the create and update of one document must
 * carry different module ids, and the two local exports must differ); an
 * update of an unchanged document sending other bytes than the republish,
 * which would make every unchanged edit look like a change; an update
 * of a changed document minting ids the republish minted, so an id of D′
 * would name an entity of D; and a document with media whose capture lacks
 * the upload Nova sends after the import, sends it to another app, or
 * carries other bytes than the uploaded asset's.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import AdmZip from "adm-zip";
import { expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
} from "@/lib/deployment/__tests__/publishFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	readConfigurations,
	readDocuments,
	writePublishCaptures,
} from "../writePublishCaptures";

/** The documents file the writer reads, as JSON. */
async function documentsFile(): Promise<unknown[]> {
	const table = wireTable("facilities", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const rows = [
		wireRow(table, "b", { code: "002", name: "Hospital" }),
		wireRow(table, "a", { code: "001", name: "École & Clinic" }),
	];
	const image = testMediaAssetId("capture-writer-image");
	const png = await readFile("public/nova-icons/household.png");
	const clinic = toPersistableDoc(clinicVisitsDocument());
	return JSON.parse(
		JSON.stringify([
			{
				id: "clinic-visits",
				doc: clinic,
				compiledAtSeq: 1,
				edited: {
					doc: { ...clinic, appName: "Clinic visits, renamed" },
					compiledAtSeq: 2,
				},
			},
			{
				// An edit that leaves the document as it was.
				id: "clinic-visits-unchanged",
				doc: clinic,
				compiledAtSeq: 1,
				edited: { doc: clinic, compiledAtSeq: 1 },
			},
			{
				id: "search-lookup-media",
				doc: toPersistableDoc(searchLookupMediaDocument(table, image)),
				compiledAtSeq: 3,
				lookup: {
					projectId: "program",
					projectRevision: "4",
					definitions: [table],
					rowsByTable: { [table.id]: rows },
				},
				media: {
					[image]: {
						kind: "image",
						mimeType: "image/png",
						extension: ".png",
						base64: png.toString("base64"),
					},
				},
			},
		]),
	);
}

/** The writer's input, written as the documents and configurations files hold it. */
async function input() {
	return {
		entries: readDocuments(await documentsFile()),
		configurations: readConfigurations([{ id: "none", flags: [] }]),
	};
}

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

/** The app JSON a captured import carries, read through its sidecar's content type. */
async function appOf(
	written: ReadonlyMap<string, Buffer>,
	name: string,
): Promise<{
	modules: {
		unique_id: string;
		forms: { unique_id: string; xmlns: string }[];
	}[];
}> {
	const read = (path: string) => {
		const bytes = written.get(path);
		if (bytes === undefined) throw new Error(`Nothing was written at ${path}.`);
		return bytes;
	};
	const sidecar = JSON.parse(read(`${name}.json`).toString());
	const form = await new Response(new Uint8Array(read(`${name}.body`)), {
		headers: { "content-type": sidecar.contentType },
	}).formData();
	const file = form.get("app_file");
	if (!(file instanceof Blob)) throw new Error(`${name} carries no app file.`);
	return JSON.parse(await file.text());
}

it("writes the same bytes on every run for a seed, keeps Nova's minted identities apart, and sends an unchanged update as the republish", {
	// Three runs over three documents, each capturing every publish and
	// writing every archive.
	timeout: 30_000,
}, async () => {
	const root = await mkdtemp(join(tmpdir(), "nova-publish-captures-"));
	try {
		const { entries, configurations } = await input();
		const runs: Map<string, Buffer>[] = [];
		// The runs happen at different times: whatever reads the clock must not
		// reach the files.
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (const [run, at] of [
				["first", "2026-03-01T00:00:00Z"],
				["second", "2027-06-15T12:34:56Z"],
			] as const) {
				vi.setSystemTime(new Date(at));
				await writePublishCaptures(entries, configurations, join(root, run));
				runs.push(await files(join(root, run)));
			}
		} finally {
			vi.useRealTimers();
		}
		expect(
			await writePublishCaptures(entries, configurations, join(root, "nova")),
		).toEqual([
			"clinic-visits: minimum sent, none sent",
			"clinic-visits-unchanged: minimum sent, none sent",
			"search-lookup-media: minimum sent, none refused",
		]);
		const nova = await files(join(root, "nova"));
		expect(
			[...nova.keys()].filter(
				(path) =>
					path.startsWith("clinic-visits/") ||
					path.startsWith("search-lookup-media/"),
			),
		).toEqual([
			"clinic-visits/minimum/create.import.body",
			"clinic-visits/minimum/create.import.json",
			"clinic-visits/minimum/local-1.ccz",
			"clinic-visits/minimum/local-2.ccz",
			"clinic-visits/minimum/outcome.json",
			"clinic-visits/minimum/update-edited.import.body",
			"clinic-visits/minimum/update-edited.import.json",
			"clinic-visits/minimum/update.import.body",
			"clinic-visits/minimum/update.import.json",
			"clinic-visits/none/create.import.body",
			"clinic-visits/none/create.import.json",
			"clinic-visits/none/local-1.ccz",
			"clinic-visits/none/local-2.ccz",
			"clinic-visits/none/outcome.json",
			"clinic-visits/none/update-edited.import.body",
			"clinic-visits/none/update-edited.import.json",
			"clinic-visits/none/update.import.body",
			"clinic-visits/none/update.import.json",
			"clinic-visits/verdict.json",
			"search-lookup-media/minimum/create.import.body",
			"search-lookup-media/minimum/create.import.json",
			"search-lookup-media/minimum/create.lookup.body",
			"search-lookup-media/minimum/create.lookup.json",
			"search-lookup-media/minimum/create.media.body",
			"search-lookup-media/minimum/create.media.json",
			"search-lookup-media/minimum/local-1.ccz",
			"search-lookup-media/minimum/local-2.ccz",
			"search-lookup-media/minimum/outcome.json",
			"search-lookup-media/minimum/update.import.body",
			"search-lookup-media/minimum/update.import.json",
			"search-lookup-media/minimum/update.lookup.body",
			"search-lookup-media/minimum/update.lookup.json",
			"search-lookup-media/minimum/update.media.body",
			"search-lookup-media/minimum/update.media.json",
			"search-lookup-media/none/outcome.json",
			"search-lookup-media/verdict.json",
		]);
		for (const run of runs) {
			expect([...run.keys()]).toEqual([...nova.keys()]);
			for (const [path, bytes] of nova) {
				expect(run.get(path)?.equals(bytes), path).toBe(true);
			}
		}

		// Nova's own minting reaches the files: each export draws other ids.
		const created = await appOf(nova, "clinic-visits/none/create.import");
		const updated = await appOf(nova, "clinic-visits/none/update.import");
		expect(created.modules[0]?.unique_id).toMatch(/^[0-9a-f]{40}$/);
		expect(created.modules[0]?.unique_id).not.toBe(
			updated.modules[0]?.unique_id,
		);
		const [local1, local2] = [
			nova.get("clinic-visits/none/local-1.ccz"),
			nova.get("clinic-visits/none/local-2.ccz"),
		];
		expect(local1 !== undefined && local2 !== undefined).toBe(true);
		expect(local1?.equals(local2 ?? Buffer.alloc(0))).toBe(false);

		// An edit that changes nothing sends exactly the republish; a rename
		// does not, and mints none of the ids the republish minted.
		const body = (path: string) => nova.get(path) ?? Buffer.alloc(0);
		expect(
			body("clinic-visits-unchanged/none/update-edited.import.body").equals(
				body("clinic-visits-unchanged/none/update.import.body"),
			),
		).toBe(true);
		expect(
			body("clinic-visits/none/update-edited.import.body").equals(
				body("clinic-visits/none/update.import.body"),
			),
		).toBe(false);
		const renamed = await appOf(
			nova,
			"clinic-visits/none/update-edited.import",
		);
		const minted = (app: typeof renamed) =>
			app.modules.flatMap((module) => [
				module.unique_id,
				...module.forms.flatMap((form) => [form.unique_id, form.xmlns]),
			]);
		const republished = new Set(minted(updated));
		expect(minted(renamed).length).toBeGreaterThan(1);
		expect(minted(renamed).filter((id) => republished.has(id))).toEqual([]);

		// The document with an uploaded image sends its media after each
		// import, to the app the import made, as one ZIP holding the image's
		// bytes under its wire path; the republish sends the create's ZIP.
		const media = "search-lookup-media/minimum";
		expect(
			JSON.parse(body(`${media}/outcome.json`).toString()).create.requests,
		).toEqual(["lookup", "import", "media"]);
		const sidecar = JSON.parse(body(`${media}/create.media.json`).toString());
		expect(sidecar).toMatchObject({
			method: "POST",
			path: "/a/nova-proof/apps/api/nova-proof-placeholder-app/multimedia/",
			fields: ["waf_padding", "bulk_upload_file"],
		});
		const upload = (
			await new Response(new Uint8Array(body(`${media}/create.media.body`)), {
				headers: { "content-type": sidecar.contentType },
			}).formData()
		).get("bulk_upload_file");
		if (!(upload instanceof File)) throw new Error("The upload has no ZIP.");
		expect([upload.name, upload.type]).toEqual([
			"multimedia.zip",
			"application/zip",
		]);
		const png = await readFile("public/nova-icons/household.png");
		const hash = createHash("sha256").update(png).digest("hex");
		const zipped = new AdmZip(Buffer.from(await upload.arrayBuffer()))
			.getEntries()
			.filter((entry) => !entry.isDirectory);
		const image = zipped.find(
			(entry) => entry.entryName === `commcare/${hash}.png`,
		);
		expect(image?.getData().equals(png)).toBe(true);
		expect(
			body(`${media}/update.media.body`).equals(
				body(`${media}/create.media.body`),
			),
		).toBe(true);
		expect(nova.has("clinic-visits/minimum/create.media.body")).toBe(false);
	} finally {
		vi.useRealTimers();
		await rm(root, { recursive: true, force: true });
	}
});

/** The search document's lookup snapshot and its one media asset, in a documents file. */
interface SearchEntry {
	lookup: {
		projectRevision: string;
		definitions: { name: string; columns: { id: string }[] }[];
		rowsByTable: Record<
			string,
			{ id: string; values: Record<string, unknown> }[]
		>;
	};
	media: Record<string, Record<string, unknown>>;
}

it.each<[string, string, (entry: SearchEntry) => void]>([
	[
		"an extension without its dot",
		"extension",
		(entry) => {
			for (const asset of Object.values(entry.media)) asset.extension = "png";
		},
	],
	[
		"bytes that are not canonical base64",
		"base64",
		(entry) => {
			for (const asset of Object.values(entry.media)) {
				asset.base64 = `${String(asset.base64)}!`;
			}
		},
	],
	[
		"an image type filed as audio",
		"kind",
		(entry) => {
			for (const asset of Object.values(entry.media)) asset.kind = "audio";
		},
	],
	[
		"a Project revision the store never writes",
		"projectRevision",
		(entry) => {
			entry.lookup.projectRevision = "04";
		},
	],
	[
		"a table name the store would trim",
		"trims",
		(entry) => {
			const [definition] = entry.lookup.definitions;
			if (definition) definition.name = ` ${definition.name} `;
		},
	],
	[
		"a row cell for a column the table does not have",
		"not part of this table",
		(entry) => {
			const [rows] = Object.values(entry.lookup.rowsByTable);
			const [row] = rows ?? [];
			if (row) row.values["01900000-0000-7000-8000-000000000000"] = "x";
		},
	],
	[
		"a table without its rows",
		"no rowsByTable entry",
		(entry) => {
			entry.lookup.rowsByTable = {};
		},
	],
])(
	"refuses a documents file holding %s, naming the document and the field",
	async (_, field, corrupt) => {
		const accepted = await documentsFile();
		expect(readDocuments(accepted)).toHaveLength(3);
		const corrupted = structuredClone(accepted);
		corrupt(corrupted[2] as SearchEntry);
		expect(() => readDocuments(corrupted)).toThrow(
			expect.objectContaining({
				message: expect.stringMatching(
					new RegExp(`search-lookup-media.*${field}`, "s"),
				),
			}),
		);
	},
);
