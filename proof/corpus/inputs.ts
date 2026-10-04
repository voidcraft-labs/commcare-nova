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
 *    local, judge}
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
 *   saves in HQ over A (`hqSide`), the create's request, the lookup workbook
 *   it pushed and the media upload it sent, and the privilege inputs: the minimum
 *   configuration's create and D′'s update there, whose apps
 *   `proof/checks/configurations.py::privileges_for` reads (with what else
 *   each sent, which its sidecar names).
 * - `b`: the republish's request and the workbook and media upload it names.
 * - `b_edit`: D′'s update request and the workbook and media upload it
 *   names, with `edit/document.json` and `edit/verdict.json`.
 * - `local`: each local archive (`local.ccz`, `local-again.ccz`,
 *   `edit/local.ccz`).
 * - `judge`: what only the judges read: `edit/batch.json` and a targeted
 *   document's `expected.json`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";

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
		...prefixed(
			"privileges.create.",
			await request(root, "export/minimum", "create"),
		),
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
				...prefixed("create.", await request(root, exported, "create")),
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
	for (const [role, path] of [
		["local", "local.ccz"],
		["local-again", "local-again.ccz"],
		["edit-local", "edit/local.ccz"],
	] as const) {
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
	return {
		version: 1,
		document: id,
		configurations: byConfiguration,
		local,
		judge,
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
