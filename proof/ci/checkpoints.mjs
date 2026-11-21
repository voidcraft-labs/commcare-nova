// Publish only diagnostic data while the reader is still running. This host process alone has the job's
// credential. A checkpoint is never a proof-out artifact, a group manifest or a store entry.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { create } from "./artifacts.mjs";
import { partPublisher, plainBytes } from "./checkpoint-parts.mjs";

const script = fileURLToPath(import.meta.url);
const interval = 5 * 60_000;
const bound = 1024 * 1024;
const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const outcomes = new Set([
	"passed",
	"failed",
	"error",
	"skipped",
	"xfailed",
	"xpassed",
]);
// Only this vocabulary crosses the artifact boundary. Raw walks, answers and arbitrary worker text never do.
const fixedStages = new Set([
	"formplayer",
	"webapps",
	"android",
	"connect",
	"local.ccz",
	"local/Core admission",
	"Core sessions",
	"A",
	"B",
	"local",
	"proof4",
	"proof4-save",
	"first save",
	"second save",
	"open opportunity",
	"Connect restore",
	"Connect collect",
	...[
		"app settings",
		"add-ons",
		"UI translations",
		"module settings",
		"case list",
		"case search",
		"case detail",
		"form settings",
		"case management",
		"case management (advanced)",
		"user properties",
	].map((name) => `save ${name}`),
]);
const stageShapes = [
	/^(?:minimum|maximum|single flag [0-9]{1,4})\/(?:a|b|b_aligned|b_edit|recreate [AB])$/,
	/^walk [0-9]{1,7}$/,
	/^webapps-(?:places-)?(?:desktop|small|preview)(?:-whole)?-(?:home|[0-9]{1,7})$/,
	/^HQ (?:build|create|media|publish|save-build|app_settings|view_form [0-9]{1,4}\.[0-9]{1,4}|view_module [0-9]{1,4})$/,
	/^Vellum form [0-9]{1,4}\.[0-9]{1,4}$/,
	/^(?:A|B|B-edit|local|save|republish|archive) (?:install|installs|menus|form|walks?|details|search|session|app)(?: delivered)? (?:tablet|phone)$/,
];
const readerScope = "(?:formplayer|webapps|android/(?:phone|tablet))";
const pageScope =
	"page/(?:app_settings|view_form/[0-9]{1,4}\\.[0-9]{1,4}|view_module/[0-9]{1,4})";
const vellumScope = "vellum/[0-9]{1,4}\\.[0-9]{1,4}";
const sectionSlugs = new Set(
	[...fixedStages]
		.filter((s) => s.startsWith("save "))
		.map((s) =>
			s
				.slice(5)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/-$/, ""),
		),
);
const replayScope = new RegExp(
	`^(?:${readerScope}|${pageScope}|${vellumScope}(?:/(?:first|second)/${readerScope})?|${pageScope}/section/([a-z0-9_-]{1,48})/${readerScope})$`,
);
function knownScope(scope) {
	if (typeof scope !== "string" || scope.length > 128) return false;
	const match = replayScope.exec(scope);
	return Boolean(
		match && (!match[1] || sectionSlugs.has(match[1].replaceAll("_", "-"))),
	);
}

async function sample(output) {
	return JSON.parse(
		(await plainBytes(join(output, ".reader-progress.json"), bound)).toString(
			"utf8",
		),
	);
}

async function loadQueue(path) {
	if (!path) return undefined;
	let raw;
	try {
		raw = await readFile(path);
	} catch (err) {
		if (err.code === "ENOENT") return undefined; // The host's wait command may still be downloading it.
		throw err;
	}
	const blocks = new Map(
		JSON.parse(raw).blocks.map(({ id, groups }) => [
			id,
			new Set(groups.map(({ group }) => group)),
		]),
	);
	return { digest: digest(raw), blocks };
}

function labels(value) {
	if (typeof value !== "string" || value.length > 512)
		throw new Error("invalid stage");
	return value
		.split(" / ")
		.filter(
			(label) =>
				fixedStages.has(label) ||
				stageShapes.some((shape) => shape.test(label)),
		)
		.slice(0, 12);
}

function activity(row) {
	const fields = [
		"elapsed",
		"stageSeconds",
		"parts",
		"native",
		"lastNativeSeconds",
		"lastPartSeconds",
	];
	if (!fields.every((field) => count(row[field])))
		throw new Error("invalid activity counters");
	const projection = Object.fromEntries(
		fields.map((field) => [field, row[field]]),
	);
	for (const field of ["stage", "lastNative", "lastPart"])
		projection[field] = labels(row[field]);
	for (const prefix of ["input", "lastInput"]) {
		const key = `${prefix}Sha256`,
			scope = `${prefix}Scope`,
			path = `${prefix}Stage`;
		if (row[key] === undefined) continue;
		if (
			typeof row[key] !== "string" ||
			!/^[a-f0-9]{64}$/.test(row[key]) ||
			!knownScope(row[scope])
		)
			throw new Error("invalid replay receipt");
		projection[key] = row[key];
		projection[scope] = row[scope];
		projection[path] = labels(row[path]);
	}
	if (row.lastInputSha256 !== undefined) {
		if (!count(row.lastInputSeconds))
			throw new Error("invalid operation duration");
		projection.lastInputSeconds = row.lastInputSeconds;
	}
	return projection;
}

function project(raw, queues) {
	const records = {};
	const seen = new Set();
	for (const kind of ["finished", "active", "workerLost"]) {
		const rows = raw[kind];
		if (!Array.isArray(rows) || rows.length > 4096)
			throw new Error("invalid progress groups");
		records[kind] = rows.map((row) => {
			const { phase, block, group } = row;
			if (
				!["early", "main"].includes(phase) ||
				!queues[phase]?.blocks.get(block)?.has(group) ||
				seen.has(group)
			)
				throw new Error("progress group is absent from its queue or repeated");
			seen.add(group);
			const location = { phase, block, group };
			if (kind === "finished") {
				const entries = Object.entries(row.outcomes);
				if (!entries.every(([name, n]) => outcomes.has(name) && count(n)))
					throw new Error("invalid outcome counts");
				return {
					...location,
					outcomes: Object.fromEntries(entries),
					...(row.stage !== undefined ? activity(row) : {}),
				};
			}
			return {
				...location,
				...(row.stage !== undefined || kind === "active" ? activity(row) : {}),
			};
		});
	}
	if (![null, "SIGINT", "SIGTERM", "work-deadline"].includes(raw.stop))
		throw new Error("invalid stop");
	return { ...records, stop: raw.stop };
}

export function shardPublisher({
	output,
	early,
	main,
	source,
	corpus = undefined,
	checkout = undefined,
	upload = create,
}) {
	const { run, attempt, shard, commit, image, fingerprints } = source;
	if (
		!/^[1-9][0-9]*$/.test(run) ||
		!/^[1-9][0-9]*$/.test(attempt) ||
		!/^[a-zA-Z0-9_-]{1,80}$/.test(shard) ||
		!/^[a-f0-9]{40}$/.test(commit) ||
		!/^sha256:[a-f0-9]{64}$/.test(image) ||
		!/^[a-f0-9]{64}$/.test(fingerprints)
	)
		throw new Error("The hosted checkpoint has no valid source identity.");
	const queues = {};
	const atoms =
		corpus && checkout
			? partPublisher({ output, corpus, checkout, source, upload })
			: undefined;
	let last,
		next = 0,
		nextSample = 0,
		terminalSent = false,
		sequence = 0;
	return async function poll(now) {
		if (now < nextSample || (!atoms && now < next)) return;
		nextSample = now + 2_000;
		let raw;
		try {
			raw = await sample(output);
		} catch (error) {
			if (error.code === "ENOENT") return;
			nextSample = next = now + interval;
			throw error;
		}
		if (
			raw &&
			Array.isArray(raw.finished) &&
			Array.isArray(raw.active) &&
			Array.isArray(raw.workerLost) &&
			!raw.finished.length &&
			!raw.active.length &&
			!raw.workerLost.length
		)
			return;
		// Count attempts as well as acknowledgments. A failed transport can retry the latest snapshot
		// at the next interval without flooding the service or claiming it was finalized.
		queues.early ??= await loadQueue(early);
		queues.main ??= await loadQueue(main);
		let report;
		try {
			report = project(raw, queues);
		} catch (error) {
			nextSample = now + interval;
			throw error;
		}
		const record = {
			kind: "reader-progress",
			version: 1,
			source,
			queues: Object.fromEntries(
				Object.entries(queues)
					.filter(([, q]) => q)
					.map(([phase, q]) => [phase, q.digest]),
			),
			...report,
			...atoms?.state(),
		};
		atoms?.poll(record, now);
		if (now < next && (!report.stop || terminalSent)) return;
		next = now + interval;
		const payload = JSON.stringify(record);
		if (Buffer.byteLength(payload) > bound)
			throw new Error("progress exceeds its size limit");
		const current = digest(payload);
		if (current === last) return;
		const name = `proof-progress-${shard}-${attempt}-${++sequence}.json`;
		const body = JSON.stringify({
			...record,
			publishedAt: new Date(now).toISOString(),
		});
		const id = await upload(name, body, { retentionDays: 14, archive: true });
		last = current;
		if (report.stop) terminalSent = true;
		console.error(`Reader progress saved in ${name} (artifact ${id}).`);
	};
}

// Keep a slow artifact service outside the shard and its finalizer. Only completed uploads survive termination.
export function startCheckpoints({
	output,
	early,
	main,
	shard,
	checkout,
	image,
	fingerprints,
}) {
	const source = {
		run: process.env.GITHUB_RUN_ID,
		attempt: process.env.GITHUB_RUN_ATTEMPT,
		shard,
		commit: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: checkout,
			encoding: "utf8",
			timeout: 5000,
		}).trim(),
		image,
		fingerprints: digest(fingerprints),
		runner: process.env.RUNNER_NAME,
	};
	const child = spawn(
		process.execPath,
		[
			script,
			JSON.stringify({
				output,
				early,
				main,
				source,
				checkout,
				corpus: process.env.PROOF_CORPUS,
			}),
		],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	const stopped = new Promise((resolve) => {
		child.on("error", () => {
			console.error("Reader progress publisher could not start.");
			resolve();
		});
		child.on("exit", resolve);
	});
	return async () => {
		child.kill("SIGKILL");
		await stopped;
	};
}

if (process.argv[1] === script) {
	const poll = shardPublisher(JSON.parse(process.argv[2]));
	for (;;) {
		try {
			await poll(Date.now());
		} catch {
			console.error(
				"Reader progress could not be saved. A later checkpoint can retry.",
			);
		}
		await sleep(2000);
	}
}
