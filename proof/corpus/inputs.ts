/**
 * Each corpus document's input manifest, `<id>/inputs.json`: the digest of
 * every file a check reads, grouped by the part of the document's HQ tree
 * that reads it, so the lane can key what it observes by exactly the bytes
 * it reads and a queue builder can read the keys with Python's standard
 * library alone. The corpus's own `inputs.json` lists each document's
 * manifest digest.
 *
 *   {version: 1, document,
 *    configurations: {<config>: {a, b, b_edit?}},
 *    local, judge, importFile}
 *
 * Each part maps a role to `{path, digest}`: the path relative to the
 * document's directory, and `sha256:<hex>` over the file's bytes, or for a
 * local archive `entries-sha256:<hex>` over its entries (each name with the
 * sha256 of its bytes, sorted by name), which names what the archive holds
 * whatever zip framing carries it. Roles are the same in `b` and `b_edit`,
 * so a document whose update to D′ sends exactly its republish of D shows
 * equal request digests under one role.
 *
 * Equal request digests are not enough for B-edit to reuse what was
 * observed over B: the observations over B-edit read D′ beyond the bytes
 * HQ receives. Proof 4's sessions run over D′'s case database
 * (`proof/checks/proof4.py::edit_editability` over
 * `proof/checks/casedata.py::case_database`), and the intent checks hold
 * B-edit to D′'s stated intent (`proof/checks/intent.py::document_intent`),
 * so `b_edit` names `edit/document.json`, and a key for B-edit holds what
 * those read of it beside the request digests: an edit to case-type or
 * worker data alone sends the republish's bytes and changes the cases the
 * sessions run over.
 *
 * - `a`, per configuration: `configurations.json`, `document.json`,
 *   `verdict.json`, `hq-side.json` where the document carries what a person
 *   saves in HQ over A (`hqSide`), the first publish's requests with the
 *   lookup workbook it pushed and the media upload it sent, and the
 *   privilege inputs: the minimum configuration's first publish and D′'s
 *   update there, whose apps `proof/checks/configurations.py::privileges_for`
 *   reads (with what else each sent, which its sidecar names). A first
 *   publish is the create alone in the legacy layout, under `create.`; in
 *   the two-import layout (a create sidecar marked `"layout": 2`) it is the
 *   shell's create under `create.` and the content import under `content.`,
 *   which names the workbook and the media, and the privileges name both
 *   (`privileges.create.`, `privileges.content.`).
 * - `b`: the republish's request and the workbook and media upload it names.
 * - `b_edit`: D′'s update request and the workbook and media upload it
 *   names, with `edit/document.json` and `edit/verdict.json`.
 * - `local`: each local archive (`local.ccz`, `local-again.ccz`,
 *   `edit/local.ccz`, and `local-empty-list-text.ccz` where a configuration
 *   the document runs under holds the flag that archive was compiled for,
 *   `EMPTY_LIST_TEXT_ARCHIVE`).
 * - `judge`: what only the judges read: `edit/batch.json` and a targeted
 *   document's `expected.json`.
 * - `importFile`: the HQ import file (`import-file.zip`), by its entries as a
 *   local archive is, which no check reads and the HQ package's import-page
 *   tests do (`proof/hq/test_import_file.py`): the corpus's `inputs.json`
 *   digest of the document's manifest is what that package's outcome is
 *   keyed by (`proof/store/queue.py::PACKAGE_DATA`), so a change to the file
 *   moves it.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { TWO_IMPORT_LAYOUT } from "./publish";

/**
 * The flag a local archive's bytes depend on: under `USH_EMPTY_CASE_LIST_TEXT`
 * every short detail carries the empty-list text, as HQ's build in that
 * project space does (`lib/commcare/compiler.ts::CompileOptions.emptyCaseListText`).
 */
export const EMPTY_LIST_TEXT_FLAG = "USH_EMPTY_CASE_LIST_TEXT";

/**
 * The local archive of D compiled for a project space that holds
 * `EMPTY_LIST_TEXT_FLAG`, the archive of each configuration that holds it;
 * `local.ccz` is every other configuration's.
 */
export const EMPTY_LIST_TEXT_ARCHIVE = "local-empty-list-text.ccz";

/** Each local archive a document may carry, by its role in `local`. */
export const LOCAL_ROLES = [
	["local", "local.ccz"],
	["local-again", "local-again.ccz"],
	["edit-local", "edit/local.ccz"],
	["local-empty-list-text", EMPTY_LIST_TEXT_ARCHIVE],
] as const;

/** One input file: where it is under the document's directory, and its digest. */
export interface InputFile {
	readonly path: string;
	readonly digest: string;
}

/** One part's inputs, by role. */
export type InputPart = Readonly<Record<string, InputFile>>;

export interface ConfigurationInputs {
	readonly a: InputPart;
	readonly b: InputPart;
	readonly b_edit?: InputPart;
}

export interface DocumentInputs {
	readonly version: 1;
	readonly document: string;
	readonly configurations: Readonly<Record<string, ConfigurationInputs>>;
	readonly local: InputPart;
	readonly judge: InputPart;
	readonly importFile: InputPart;
}

export interface CorpusInputs {
	readonly version: 1;
	/** Each document's `inputs.json` digest, in the index's order. */
	readonly documents: Readonly<Record<string, string>>;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The digest of an archive's entries: each file entry's name with the
 * sha256 of its bytes, sorted by name.
 */
export function archiveDigest(bytes: Buffer): string {
	const entries = new AdmZip(bytes)
		.getEntries()
		.filter((entry) => !entry.isDirectory)
		.map((entry) => [entry.entryName, sha256(entry.getData())] as const)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `entries-sha256:${sha256(Buffer.from(JSON.stringify(entries)))}`;
}

async function file(root: string, path: string): Promise<InputFile> {
	return {
		path,
		digest: `sha256:${sha256(await readFile(join(root, path)))}`,
	};
}

/**
 * A captured request's body and sidecar, and what else its sidecar names:
 * the lookup workbook pushed before it (`lookups`) and the media upload
 * sent after it (`media`), each a body with its own sidecar.
 */
async function request(
	root: string,
	directory: string,
	name: string,
): Promise<Record<string, InputFile>> {
	const sidecar = `${directory}/${name}.json`;
	const meta = JSON.parse(await readFile(join(root, sidecar), "utf8")) as {
		lookups?: string;
		media?: string;
	};
	const part: Record<string, InputFile> = {
		"request.body": await file(root, `${directory}/${name}.body`),
		"request.json": await file(root, sidecar),
	};
	for (const role of ["lookups", "media"] as const) {
		const named = meta[role];
		if (named === undefined) continue;
		const base = named.replace(/\.body$/, "");
		part[`${role}.body`] = await file(root, `${directory}/${base}.body`);
		part[`${role}.json`] = await file(root, `${directory}/${base}.json`);
	}
	return part;
}

/**
 * Whether the first publish in `directory` is two imports: its create's
 * sidecar is marked with the layout (`./publish.ts::TWO_IMPORT_LAYOUT`).
 */
async function twoImports(root: string, directory: string): Promise<boolean> {
	const meta = JSON.parse(
		await readFile(join(root, `${directory}/create.json`), "utf8"),
	) as { layout?: unknown };
	return meta.layout === TWO_IMPORT_LAYOUT;
}

/**
 * The first publish's roles in `directory`: the create under `<prefix>create.`
 * and, in the two-import layout, the content import under `<prefix>content.`.
 */
async function firstPublish(
	root: string,
	directory: string,
	prefix = "",
): Promise<Record<string, InputFile>> {
	return {
		...prefixed(`${prefix}create.`, await request(root, directory, "create")),
		...((await twoImports(root, directory))
			? prefixed(`${prefix}content.`, await request(root, directory, "content"))
			: {}),
	};
}

/** `request`'s roles, each under a prefix. */
function prefixed(
	prefix: string,
	part: Record<string, InputFile>,
): Record<string, InputFile> {
	return Object.fromEntries(
		Object.entries(part).map(([role, input]) => [`${prefix}${role}`, input]),
	);
}

/**
 * The manifest of the document written at `root`, under the configurations
 * its exports were captured in.
 */
export async function documentInputs(
	root: string,
	id: string,
	configurations: readonly string[],
): Promise<DocumentInputs> {
	const edited = existsSync(join(root, "edit", "batch.json"));
	const privileges: Record<string, InputFile> = {
		...(await firstPublish(root, "export/minimum", "privileges.")),
		...(edited && existsSync(join(root, "edit/export/minimum/update.json"))
			? prefixed(
					"privileges.update.",
					await request(root, "edit/export/minimum", "update"),
				)
			: {}),
	};
	const shared = {
		configurations: await file(root, "configurations.json"),
		document: await file(root, "document.json"),
		verdict: await file(root, "verdict.json"),
		...(existsSync(join(root, "hq-side.json")) && {
			hqSide: await file(root, "hq-side.json"),
		}),
	};
	const byConfiguration: Record<string, ConfigurationInputs> = {};
	for (const name of configurations) {
		const exported = `export/${name}`;
		const update = `edit/export/${name}`;
		byConfiguration[name] = {
			a: {
				...shared,
				...(await firstPublish(root, exported)),
				...privileges,
			},
			b: await request(root, exported, "republish"),
			...(edited && existsSync(join(root, update, "update.json"))
				? {
						b_edit: {
							...(await request(root, update, "update")),
							document: await file(root, "edit/document.json"),
							verdict: await file(root, "edit/verdict.json"),
						},
					}
				: {}),
		};
	}
	const local: Record<string, InputFile> = {};
	for (const [role, path] of LOCAL_ROLES) {
		if (!existsSync(join(root, path))) continue;
		local[role] = {
			path,
			digest: archiveDigest(await readFile(join(root, path))),
		};
	}
	const judge: Record<string, InputFile> = {};
	if (edited) judge.batch = await file(root, "edit/batch.json");
	if (existsSync(join(root, "expected.json"))) {
		judge.expected = await file(root, "expected.json");
	}
	const importFile: Record<string, InputFile> = {};
	if (existsSync(join(root, "import-file.zip"))) {
		importFile["import-file"] = {
			path: "import-file.zip",
			digest: archiveDigest(await readFile(join(root, "import-file.zip"))),
		};
	}
	return {
		version: 1,
		document: id,
		configurations: byConfiguration,
		local,
		judge,
		importFile,
	};
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** Write `<root>/inputs.json` and return its digest. */
export async function writeDocumentInputs(
	root: string,
	id: string,
	configurations: readonly string[],
): Promise<string> {
	const text = jsonText(await documentInputs(root, id, configurations));
	await writeFile(join(root, "inputs.json"), text);
	return `sha256:${sha256(Buffer.from(text))}`;
}

/** Write the corpus's `inputs.json`: each document's manifest digest, in the index's order. */
export async function writeCorpusInputs(
	out: string,
	documents: readonly { readonly id: string; readonly inputs: string }[],
): Promise<void> {
	const inputs: CorpusInputs = {
		version: 1,
		documents: Object.fromEntries(
			documents.map((document) => [document.id, document.inputs]),
		),
	};
	await writeFile(join(out, "inputs.json"), jsonText(inputs));
}
