// The reader bundle the proof lane's judges run: `proof/reader/build.mjs`,
// built twice, and the built `reader.mjs` run as a judge runs it
// (`node reader.mjs <requests> <answers>`) from a directory that holds
// nothing else, over CommCare HQ's retained answers for the corpus document
// `navigation-base` after Nova's publish (`proof/hq-reads/`), and over the
// same app with a menu icon mapped to one of the lane's stand-in pictures
// (`proof/matrix/stand-ins.json`), the one change made here to HQ's answer.
//
// Contract: two builds of one checkout are the same bytes, every file of the
// directory, and `reader.json` names the bundle's digest and `runtime.json`
// each file of the native runtime beside it; the bundle resolves no module
// outside its directory and opens no socket while it reads, and judges a
// picture with the sharp it carries; a read back of the document gives its
// canonical form with no difference, a request for the claim log gives one,
// and a first reading that comes in answers its claim counts and, for each
// `holds` fragment, whether its key names an entity at all; and a request
// for which the lane holds no answer ends the reading naming its path.
//
// Plausible failure: a build whose bytes move with the machine or the time,
// so every corpus document is judged again for nothing; a bundle that reaches
// the checkout's `node_modules`, which a lane shard does not hold, or carries
// a runtime that cannot judge a picture there; a reader the bundle carries
// that reads back another document than the one Nova published; an entry
// that answers a reading without its claims, so every base the lane reads
// counts no claim; a fragment of a key the reading does not hold answered as
// one whose entity holds nothing, so a row's null value holds of nothing; or a
// peer that lets a reading the lane cannot reproduce
// pass.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	type RetainedHqAnswer as HelperAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { publishedCorpus } from "@/lib/commcare/reader/__tests__/publishedDocuments";
import type { CorpusDocument } from "@/proof/corpus/documents";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import type { LaneReadInput } from "@/proof/reader/laneReading";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/*
 * Each build bundles Nova's whole reading path, and each run starts Node
 * over it and reads an app with acceptance: seconds apiece on an idle
 * machine, many more under a full suite's load.
 */
const BUDGET_MS = 300_000;

/** What a run of the bundle wrote to its trap: each module it resolved outside Node's own, with
 *  the file it resolved to, and each socket it opened. */
const TRAP = `
const Module = require("node:module");
const net = require("node:net");
const { appendFileSync } = require("node:fs");
const log = process.env.READER_TRAP;
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	const resolved = resolveFilename.call(this, request, ...rest);
	if (!Module.isBuiltin(request)) appendFileSync(log, "module " + request + " " + resolved + "\\n");
	return resolved;
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	appendFileSync(log, "socket " + JSON.stringify(args[0]) + "\\n");
	return connect.apply(this, args);
};
`;

let scratch: string;
const children = new Set<ChildProcess>();

interface Ran {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function run(
	args: readonly string[],
	options: { readonly cwd: string; readonly env?: Record<string, string> },
): Promise<Ran> {
	const child = spawn(process.execPath, [...args], {
		cwd: options.cwd,
		env: {
			NODE_ENV: "test",
			PATH: process.env.PATH ?? "",
			TZ: "UTC",
			...options.env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});
	return new Promise<Ran>((resolveRun, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			children.delete(child);
			resolveRun({ code, stdout, stderr });
		});
	});
}

async function build(out: string): Promise<void> {
	const built = await run(["proof/reader/build.mjs", "--out", out], {
		cwd: ROOT,
	});
	if (built.code !== 0)
		throw new Error(
			`proof/reader/build.mjs exited with ${built.code}: ${built.stderr}`,
		);
}

let first: string;
let second: string;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-reader-bundle-"));
	first = join(scratch, "first");
	second = join(scratch, "second");
	await build(first);
	await build(second);
}, BUDGET_MS);

afterAll(async () => {
	for (const child of children) child.kill("SIGKILL");
	await rm(scratch, { recursive: true, force: true });
});

/** A retained answer as the lane's files hold it: the body as text. */
function asRetained(answer: HelperAnswer): RetainedHqAnswer {
	return {
		status: answer.status,
		headers: answer.headers,
		body: retainedBodyText(answer),
	};
}

/** The corpus document `navigation-base` as its `document.json` holds what a read back reads. */
function navigationBase(): CorpusDocument {
	const document = publishedCorpus().find(
		(one) => one.id === "navigation-base",
	);
	if (document === undefined)
		throw new Error("The corpus holds the document navigation-base.");
	return document;
}

function documentJson(document: CorpusDocument): Record<string, unknown> {
	return {
		id: document.id,
		source: document.source,
		doc: document.doc,
		...(document.lookup !== undefined && {
			lookup: {
				projectId: document.lookup.projectId,
				projectRevision: document.lookup.projectRevision,
				definitions: document.lookup.definitions,
				rowsByTable: Object.fromEntries(document.lookup.rowsByTable),
			},
		}),
		...(document.media !== undefined && {
			media: Object.fromEntries(
				[...document.media].map(([assetId, asset]) => [
					assetId,
					{
						kind: asset.kind,
						mimeType: asset.mimeType,
						extension: asset.extension,
						base64: asset.bytes.toString("base64"),
					},
				]),
			),
		}),
	};
}

const application = asRetained(retainedReadingRead("application"));
const APP_ID = retainedBodyJson(retainedReadingRead("application"))
	.id as string;

/** HQ's three answers for navigation-base after Nova's first publish: one bracketed read. */
const BRACKET = {
	application,
	source: asRetained(retainedGroupRead("navigation-base/app-source")),
	currentVersion: asRetained(retainedReadingRead("current-version")),
} as const;

/** The external key of navigation-base's first menu (`identity.ts::externalKeyText`), and one no menu has. */
const FIRST_MENU_KEY = JSON.stringify([
	"module",
	(
		retainedBodyJson(retainedGroupRead("navigation-base/app-source")) as {
			modules: { unique_id: string }[];
		}
	).modules[0]?.unique_id,
]);
const NO_MENU_KEY = JSON.stringify(["module", "no-menu-holds-this-id"]);

/** Runs the bundle `directory` holds over `requests`, under the trap, from that directory. */
async function readWith(
	directory: string,
	requests: readonly unknown[],
): Promise<{
	readonly ran: Ran;
	readonly answers: readonly Record<string, unknown>[] | null;
	readonly trapped: string;
}> {
	const requestsPath = join(directory, "requests.json");
	const answersPath = join(directory, "answers.json");
	const trapPath = join(directory, "trap.cjs");
	const trapLog = join(directory, "trap.log");
	await writeFile(requestsPath, JSON.stringify({ requests }));
	await writeFile(trapPath, TRAP);
	await writeFile(trapLog, "");
	await rm(answersPath, { force: true });
	const ran = await run(
		["--require", trapPath, "reader.mjs", requestsPath, answersPath],
		{ cwd: directory, env: { READER_TRAP: trapLog } },
	);
	let answers: readonly Record<string, unknown>[] | null = null;
	try {
		answers = (
			JSON.parse(await readFile(answersPath, "utf8")) as {
				answers: Record<string, unknown>[];
			}
		).answers;
	} catch {
		answers = null;
	}
	return { ran, answers, trapped: await readFile(trapLog, "utf8") };
}

/** Every file under `root`, as [its path under `root`, in / form], sorted. */
async function filesUnder(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) =>
			join(entry.parentPath, entry.name)
				.slice(root.length + 1)
				.split("\\")
				.join("/"),
		)
		.sort();
}

it(
	"builds the same bytes twice, and names the bundle's digest and every file of its runtime",
	async () => {
		const files = await filesUnder(first);
		expect(await filesUnder(second)).toEqual(files);
		for (const path of files)
			expect(
				(await readFile(join(first, path))).equals(
					await readFile(join(second, path)),
				),
				path,
			).toBe(true);
		const left = await readFile(join(first, "reader.mjs"));
		const record = JSON.parse(
			await readFile(join(first, "reader.json"), "utf8"),
		) as Record<string, unknown>;
		expect(record.sha256).toBe(createHash("sha256").update(left).digest("hex"));
		expect(record.node).toBe(
			(await readFile(join(ROOT, ".nvmrc"), "utf8")).trim(),
		);
		expect(typeof record.esbuild).toBe("string");
		const runtime = JSON.parse(
			await readFile(join(first, "runtime.json"), "utf8"),
		) as {
			platform: string;
			versions: Record<string, string>;
			packages: Record<string, string>;
			files: Record<string, string>;
		};
		const carried = files.filter((path) => path.startsWith("node_modules/"));
		expect(Object.keys(runtime.files).sort()).toEqual(carried);
		for (const path of carried)
			expect(runtime.files[path], path).toBe(
				createHash("sha256")
					.update(await readFile(join(first, path)))
					.digest("hex"),
			);
		// The sharp production's package-lock.json names, with the binding npm installed here.
		const lock = JSON.parse(
			await readFile(join(ROOT, "package-lock.json"), "utf8"),
		) as { packages: Record<string, { version: string }> };
		expect(runtime.packages["node_modules/sharp"]).toBe(
			lock.packages["node_modules/sharp"]?.version,
		);
		expect(runtime.versions.sharp).toBe(runtime.packages["node_modules/sharp"]);
		expect(
			runtime.packages[`node_modules/@img/sharp-${runtime.platform}`],
		).toBe(
			lock.packages[`node_modules/@img/sharp-${runtime.platform}`]?.version,
		);
	},
	BUDGET_MS,
);

it(
	"reads navigation-base back to its canonical form, answers its claim log and reads it first, resolving nothing outside itself",
	async () => {
		const document = navigationBase();
		const input: LaneReadInput = {
			appId: (document.doc as { appId: string }).appId,
			document: documentJson(document),
			...BRACKET,
			identity: "match",
			claims: "counts",
		};
		const { ran, answers, trapped } = await readWith(first, [
			{
				id: "read-back",
				mode: "read-back",
				input,
				expected: document.doc,
				canon: true,
			},
			{ id: "claims", mode: "claims", input },
			{
				id: "first-read",
				mode: "first-read",
				input: {
					appId: "navigation-base",
					...BRACKET,
					projectData: {
						lookupTables: asRetained(
							retainedGroupRead("lookups/lookup-tables"),
						),
						fixtureRows: {},
						media: [],
					},
					identity: "mint",
					claims: "counts",
				} satisfies LaneReadInput,
				// One fragment of the menu the source holds, and one of a key that names nothing: a
				// value of null is told from a key the reading does not hold.
				holds: [
					{ key: FIRST_MENU_KEY, pointer: "", value: null },
					{ key: NO_MENU_KEY, pointer: "/name", value: null },
				],
			},
		]);
		expect(ran.stderr).toBe("");
		expect(ran.code).toBe(0);
		expect(trapped).toBe("");
		expect(answers?.[0]).toMatchObject({
			id: "read-back",
			kind: "read",
			differences: [],
			asked: ["application", "source", "currentVersion"],
		});
		const claims = answers?.[1];
		expect(claims).toMatchObject({ id: "claims", kind: "read" });
		const lines = String(claims?.claims)
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines)
			expect(Object.keys(line)).toEqual([
				"artifact",
				"where",
				"key",
				"entry",
				"standing",
			]);
		// A first reading of the same answers into a Project that holds nothing: production's
		// gather, every answer asked once, the table list among them.
		expect(answers?.[2]).toMatchObject({
			id: "first-read",
			kind: "read",
			asked: ["application", "source", "currentVersion", "lookupTables"],
		});
		expect(answers?.[2]?.declaration).toBeDefined();
		const held = answers?.[2]?.held as readonly Record<string, unknown>[];
		expect(held.map(({ key, named }) => ({ key, named }))).toEqual([
			{ key: FIRST_MENU_KEY, named: true },
			{ key: NO_MENU_KEY, named: false },
		]);
		expect(held[0]?.found).not.toBeNull();
		expect(held[1]?.found).toBeNull();
		expect(Array.isArray(answers?.[2]?.firstPublish)).toBe(true);
		// A reading that comes in answers its claim counts too, which the lane writes a base's
		// `expected.json` from (`proof/matrix/retain.py::claimed`): navigation-base's menu has a name,
		// and each of its forms a question that takes text.
		const counts = JSON.parse(String(answers?.[2]?.claims)) as Record<
			string,
			number
		>;
		expect(counts["menus-and-case-lists/modulebase-name"]).toBe(1);
		expect(counts["questions/text-input-xsd-string"]).toBeGreaterThan(0);
	},
	BUDGET_MS,
);

it(
	"ends a first reading at a request the lane holds no answer for, naming its path, and opens no socket",
	async () => {
		// HQ's version read after a save: the bracket does not close, so production reads the app
		// again, and the lane retained one read.
		const { ran, answers, trapped } = await readWith(first, [
			{
				id: "first-read",
				mode: "first-read",
				input: {
					appId: "navigation-base",
					...BRACKET,
					currentVersion: asRetained(
						retainedReadingRead("current-version-after-save"),
					),
					projectData: {
						lookupTables: asRetained(
							retainedGroupRead("lookups/lookup-tables"),
						),
						fixtureRows: {},
						media: [],
					},
					identity: "mint",
					claims: "full",
				} satisfies LaneReadInput,
			},
		]);
		expect(ran.code).toBe(1);
		expect(answers).toBeNull();
		expect(trapped).toBe("");
		// Nova's logger writes beside it: the client's own lines about the refused request.
		expect(ran.stderr.trimEnd().split("\n").at(-1)).toBe(
			`Nova's reader asked CommCare HQ for /a/nova-proof/api/application/v1/${APP_ID}/ while it read navigation-base, and the lane holds no answer for that request. The retained answers are every request Nova's client makes of an app; either the client now asks for something new, which the lane must read and keep (proof/matrix/retain.py), or it built an address HQ does not give.`,
		);
	},
	BUDGET_MS,
);

/** The lane's stand-in picture for a path HQ's template apps map (`proof/matrix/stand-ins.json`). */
async function standInPicture(): Promise<{
	readonly path: string;
	readonly base64: string;
}> {
	const rows = JSON.parse(
		await readFile(join(ROOT, "proof/matrix/stand-ins.json"), "utf8"),
	) as { path: string; kind: string; base64: string }[];
	const picture = rows.find((row) => row.kind === "image");
	if (picture === undefined)
		throw new Error("proof/matrix/stand-ins.json holds a stand-in picture.");
	return picture;
}

it(
	"judges a picture with the sharp it carries, from a directory that holds the bundle alone",
	async () => {
		// The bundle's directory copied where no node_modules of the checkout's is an ancestor.
		const alone = await mkdtemp(join(tmpdir(), "proof-reader-alone-"));
		try {
			await cp(first, alone, { recursive: true });
			const picture = await standInPicture();
			const multimediaId = "0123456789abcdef0123456789abcdef";
			const body = retainedBodyJson(
				retainedGroupRead("navigation-base/app-source"),
			);
			const [menu] = body.modules as Record<string, unknown>[];
			if (menu === undefined)
				throw new Error("navigation-base's source holds a menu.");
			menu.media_image = { en: picture.path };
			body.multimedia_map = {
				[picture.path]: {
					doc_type: "HQMediaMapItem",
					media_type: "CommCareImage",
					multimedia_id: multimediaId,
					unique_id: "0123456789abcdef0123456789abcde0",
					version: 1,
				},
			};
			const { ran, answers, trapped } = await readWith(alone, [
				{
					id: "first-read",
					mode: "first-read",
					input: {
						appId: "navigation-base",
						...BRACKET,
						source: { ...BRACKET.source, body: JSON.stringify(body) },
						projectData: {
							lookupTables: asRetained(
								retainedGroupRead("lookups/lookup-tables"),
							),
							fixtureRows: {},
							media: [
								{
									path: picture.path,
									mediaType: "CommCareImage",
									multimediaId,
									status: 200,
									base64: picture.base64,
								},
							],
						},
						identity: "mint",
						claims: "counts",
					} satisfies LaneReadInput,
				},
			]);
			expect(ran.stderr).toBe("");
			expect(ran.code).toBe(0);
			expect(answers?.[0]).toMatchObject({
				id: "first-read",
				kind: "read",
				asked: [
					"application",
					"source",
					"currentVersion",
					"lookupTables",
					`media:${picture.path}`,
				],
			});
			const lines = trapped.split("\n").filter((line) => line !== "");
			expect(lines).toContain(
				`module sharp ${realpathSync(join(alone, "node_modules/sharp/dist/index.cjs"))}`,
			);
			const directory = `${realpathSync(alone)}/`;
			for (const line of lines) {
				expect(line.startsWith("module "), line).toBe(true);
				expect(line.split(" ").at(-1)?.startsWith(directory), line).toBe(true);
			}
		} finally {
			await rm(alone, { recursive: true, force: true });
		}
	},
	BUDGET_MS,
);
