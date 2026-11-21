// Use the fork server's real assignment and progress records, the host publisher's real Actions client,
// then a fresh download process after the original hosts and their local output have gone away.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { partPublisher } from "../checkpoint-parts.mjs";
import { shardPublisher } from "../checkpoints.mjs";
import { ArtifactService } from "./artifactService";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const publisher = join(root, "proof/ci/checkpoints.mjs");
const args = {
	run: "147",
	attempt: "2",
	shard: "review-shard-1",
	commit: "a".repeat(40),
	image: `sha256:${"b".repeat(64)}`,
	fingerprints: "c".repeat(64),
};
const name = "proof-progress-review-shard-1-2-1.json";
let scratch: string;
let out: string;
let queue: string;
let service: ArtifactService;
beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "reader-checkpoints-"));
	out = join(scratch, "out");
	queue = join(scratch, "main.json");
	await mkdir(out);
	service = new ArtifactService();
	await service.start();
});
afterEach(async () => {
	await service.stop();
	await rm(scratch, { recursive: true, force: true });
});

const observations = `
import sys,time
from pathlib import Path
from types import SimpleNamespace
from proof.lane import blocks,progress
from proof.lane.broker import Broker
out,queue = map(Path,sys.argv[1:3])
names=("corpus:hq-media","corpus:starter-agriculture")
block=blocks.Block(blocks.block_id(names),2,tuple(blocks.QueuedGroup(g) for g in names))
blocks.write_json(queue,blocks.queue_json(blocks.Queue((block,))))
broker=Broker(lambda name: 1)
broker.add_phase("main",static=True)
broker.offer("main",[block])
workers={}
for worker in (1,2):
    assignment=broker.next_for("main",worker)
    broker.started(assignment)
    if assignment.group == names[0]:
        broker.ended(assignment,{"outcomes":{"test_media.py::test_native":"passed"}})
    else:
        now=time.monotonic()
        active=progress.ActiveGroup.begin(assignment.group,now-31)
        # OS process ids and worker sequence numbers are different in a real server.
        workers[789]=SimpleNamespace(sequence=worker,active=active)
        active.update({"path":["minimum/a","save case detail","formplayer","walk 4"]},now-22)
        active.update({"path":["minimum/a","formplayer"],"completed":"native","seconds":9},now-13)
        active.update({"path":["minimum/b","proof4","formplayer","android","B app phone","private response contents"],
                       "input":{"scope":"android/phone","sha256":"d"*64,"path":["minimum/b","proof4","android","B app phone"]}},now-6)
blocks.write_json(out/".reader-progress.json",progress.checkpoint(broker,workers,{}))
from proof.store import disk
from proof.store.checkpoint import Stager
# Real immutable store record and its media blob, already settled by a different group in this open block.
delta=disk.Delta(out/"store")
media=delta.put_blob(b"synthetic media fixture")
record=delta.put_blob(disk.canonical({"kind":"a","picture":media}))
raw=bytes.fromhex("e"*64)
stored="f"*64
delta.put("parts",stored,{"record":record,"blobs":[media]})
Stager(delta,names[0],block.id,{"judge":"fixture"},{"PROOF_HQ_DETERMINISM":"on"}).settled(raw,stored)
if "two" in sys.argv[3:]:
    raw=bytes.fromhex("1"*64)
    stored="2"*64
    delta.put("parts",stored,{"record":record,"blobs":[media]})
    Stager(delta,names[0],block.id,{"judge":"fixture"},{"PROOF_HQ_DETERMINISM":"on"}).settled(raw,stored)
blocks.write_json(out.parent/"index.json",{"documents":[{"id":"hq-media","source":"hq-authored:hq-media"},{"id":"starter-agriculture","source":"hq-authored:starter-agriculture"}]})
if "wait" in sys.argv[3:]:
    import signal
    # Keep the producer and its assignment alive during the external upload. Its active operation never returns.
    def interrupted(signum, frame):
        blocks.write_json(out/".reader-progress.json",progress.checkpoint(broker,workers,{},signal.Signals(signum).name))
        sys.exit(130)
    signal.signal(signal.SIGINT,interrupted)
    print("ready",flush=True)
    signal.pause()

`;

it.each(["SIGINT", "SIGKILL"] as const)(
	"keeps the finalized sibling and current reader evidence after %s, independently of the final gate",
	async (signal) => {
		const worker = spawn("python3", ["-c", observations, out, queue, "wait"], {
			cwd: root,
			stdio: ["ignore", "pipe", "inherit"],
		});
		const workerExit = new Promise((resolve, reject) => {
			worker.once("error", reject);
			worker.once("exit", (code, signal) => resolve({ code, signal }));
		});
		try {
			await new Promise((ok, failed) => {
				worker.stdout.once("data", ok);
				worker.once("exit", () =>
					failed(new Error("Producer ended unexpectedly")),
				);
				worker.once("error", failed);
			});
			const staged = (await readdir(out)).find((file) =>
				/^\.reader-part-[0-9a-f]{64}\.bin$/.test(file),
			);
			if (!staged)
				throw new Error("The real Delta did not stage an observation.");
			const atom = `proof-part-${args.shard}-${args.attempt}-${staged.slice(".reader-part-".length)}`;
			const external = spawn(
				process.execPath,
				[
					publisher,
					JSON.stringify({
						output: out,
						main: queue,
						source: args,
						corpus: scratch,
						checkout: root,
					}),
				],
				{
					env: { ...process.env, ...service.env("original-job") },
					stdio: "ignore",
				},
			);
			const stopped = new Promise((yes, no) => {
				external.on("error", no);
				external.on("exit", yes);
			});
			try {
				await expect
					.poll(() => service.named(name)[0]?.finalized, { timeout: 6000 })
					.toBe(true);
				await expect
					.poll(() => service.named(atom)[0]?.finalized, { timeout: 6000 })
					.toBe(true);
			} finally {
				worker.kill(signal);
				external.kill(signal);
				await stopped;
			}
			await expect(workerExit).resolves.toEqual(
				signal === "SIGKILL"
					? { code: null, signal: "SIGKILL" }
					: { code: 130, signal: null },
			);
			if (signal === "SIGINT")
				expect(
					JSON.parse(await readFile(join(out, ".reader-progress.json"), "utf8"))
						.stop,
				).toBe("SIGINT");
			await rm(out, { recursive: true });
			const readback = join(scratch, "fresh");
			const reader = `
		import {client,listAll} from "./proof/ci/artifacts.mjs";
		const [row] = (await listAll()).filter(item=>item.name===process.argv[1]);
		if (!row?.digest) throw new Error("No finalized checkpoint");
		const {digestMismatch}=await (await client()).downloadArtifact(row.id,{path:process.argv[2],expectedHash:row.digest});
		if (digestMismatch) throw new Error("Wrong artifact bytes");
	`;
			await run(
				process.execPath,
				["--input-type=module", "-e", reader, name, readback],
				{ cwd: root, env: { ...process.env, ...service.env("fresh-job") } },
			);
			const atomDir = join(scratch, "recovered-atom");
			await run(
				process.execPath,
				["--input-type=module", "-e", reader, atom, atomDir],
				{ cwd: root, env: { ...process.env, ...service.env("fresh-job") } },
			);
			const identity = JSON.parse(
				await readFile(join(atomDir, "identity.json"), "utf8"),
			);
			expect(identity).toMatchObject({
				kind: "reader-part",
				source: args,
				part: { group: "corpus:hq-media", artifact: atom },
			});
			const bytes = await readFile(join(atomDir, atom));
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(
				identity.part.sha256,
			);
			// A normal artifact download can recover the complete record and the exact referenced bytes.
			const decoded = await run(
				"python3",
				[
					"-c",
					`import sys;from pathlib import Path;from proof.store.checkpoint import decoded
header,blobs=decoded(Path(sys.argv[1]).read_bytes())
assert header["group"]=="corpus:hq-media" and b"synthetic media fixture" in blobs.values()`,
					join(atomDir, atom),
				],
				{ cwd: root },
			);
			expect(decoded.stderr).toBe("");
			const body = await readFile(join(readback, name), "utf8");
			const report = JSON.parse(body);
			expect(body).not.toContain("private response");
			expect(report.source).toEqual(args);
			expect(report.queues.main).toBe(
				createHash("sha256")
					.update(await readFile(queue))
					.digest("hex"),
			);
			expect(report.finished).toMatchObject([
				{ group: "corpus:hq-media", outcomes: { passed: 1 } },
			]);
			expect(report.active).toMatchObject([
				{
					group: "corpus:starter-agriculture",
					stage: [
						"minimum/b",
						"proof4",
						"formplayer",
						"android",
						"B app phone",
					],
					native: 1,
					elapsed: 31,
					stageSeconds: 6,
					lastNative: ["minimum/a", "save case detail", "formplayer", "walk 4"],
					lastNativeSeconds: 9,
					inputSha256: "d".repeat(64),
				},
			]);
			expect(report.active[0]).not.toHaveProperty("outcomes");
			expect(report.stop).toBeNull();
			const checked = await run(
				"python3",
				[
					"-c",
					`import sys;from pathlib import Path;from proof.checks import sharding;from proof.lane import blocks
q=blocks.load_queue(sys.argv[1]);r=sharding.verify([("main",q)],[Path(sys.argv[2])]);assert r.problems and not r.chosen`,
					queue,
					readback,
				],
				{ cwd: root },
			);
			expect(checked.stderr).toBe("");
		} finally {
			worker.kill("SIGKILL");
			await workerExit;
		}
	},
);

it("refuses a foreign file or a group outside the original queue and retries a lost upload without flooding the service", async () => {
	await run("python3", ["-c", observations, out, queue], { cwd: root });
	const file = join(out, ".reader-progress.json");
	const bytes = await readFile(file);
	const attempts: string[] = [];
	const poll = shardPublisher({
		output: out,
		early: undefined,
		main: queue,
		source: args,
		upload: async (name: string) => {
			attempts.push(name);
			if (attempts.length === 1) throw new Error("transport failure");
			return 44;
		},
	});
	await rm(file);
	await symlink(queue, file);
	await expect(poll(1000)).rejects.toThrow();
	await rm(file);
	const foreign = JSON.parse(bytes.toString());
	foreign.active[0].group = "corpus:other";
	await writeFile(file, JSON.stringify(foreign));
	await expect(poll(301000)).rejects.toThrow("queue");
	expect(attempts).toEqual([]);
	await writeFile(file, bytes);
	await expect(poll(601000)).rejects.toThrow("transport failure");
	await poll(601001);
	expect(attempts).toHaveLength(1);
	await poll(901000);
	await poll(1201000);
	expect(attempts).toEqual([name, "proof-progress-review-shard-1-2-2.json"]);
});

it("saves the remaining parts of a lost worker even if a service conflict leaves one transfer unconfirmed", async () => {
	await run("python3", ["-c", observations, out, queue, "two"], { cwd: root });
	const snapshot = JSON.parse(
		await readFile(join(out, ".reader-progress.json"), "utf8"),
	);
	const report = {
		finished: [],
		active: [],
		workerLost: snapshot.finished,
		queues: {},
	};
	const calls: string[] = [];
	let refused = "";
	const transport = partPublisher({
		output: out,
		corpus: scratch,
		checkout: root,
		source: args,
		upload: async (name: string) => {
			if (!refused) refused = name;
			calls.push(name);
			if (name === refused)
				throw Object.assign(new Error("reply unconfirmed"), { status: 409 });
			return 893;
		},
	});
	for (const now of [1, 10001, 300001, 600001, 900001, 1800001]) {
		transport.poll(report, now);
		await transport.settled();
	}
	const { parts, unconfirmedParts } = transport.state();
	expect(parts).toHaveLength(1);
	expect(parts[0]).toMatchObject({ group: "corpus:hq-media", id: 893 });
	expect(parts[0].artifact).not.toBe(refused);
	expect(unconfirmedParts).toMatchObject([
		{ artifact: refused, attempts: 3, reason: "name-conflict" },
	]);
	expect(calls.filter((x) => x === refused)).toHaveLength(3);
	expect(calls.filter((x) => x === parts[0].artifact)).toHaveLength(1);
});
