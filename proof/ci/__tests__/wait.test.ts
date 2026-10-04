// proof/ci/wait.mjs is how a shard that started before the corpus was
// emitted gets the main queue and the corpus: it must bring both, the corpus
// before the queue (the lane's server takes a queue in place to mean its
// corpus is there), end the wait when the emission failed or a deadline
// passed, and never hand over bytes the service does not vouch for. These
// tests run it with the real vendored client against a controlled artifact
// service (./artifactService.ts) holding a real zstd-compressed tar.

import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ArtifactService } from "./artifactService";
import { Scripts } from "./scripts";

const run = promisify(execFile);

let scratch: string;
let service: ArtifactService;
let scripts: Scripts;

const NAMES = {
	queue: "proof-queue-1.json",
	corpus: "proof-corpus-1.tar.zst",
	failed: "proof-emission-failed-1",
};
const QUEUE = `${JSON.stringify({ version: 1, blocks: [], cached: [] })}\n`;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-wait-"));
	service = new ArtifactService();
	await service.start();
	scripts = new Scripts(service, scratch);
});

afterEach(async () => {
	await scripts.join();
	await service.stop();
	await rm(scratch, { recursive: true, force: true });
});

/**
 * A corpus directory of two documents, and its zstd-compressed tar as the emitting job uploads it; `trailing`
 * bytes of zeros after the archive's end stand for the padding tar writes after its end-of-archive blocks.
 */
async function corpus(trailing = 0): Promise<Buffer> {
	const directory = join(scratch, "emitted");
	await mkdir(join(directory, "doc-a", "export"), { recursive: true });
	await writeFile(join(directory, "index.json"), '{"documents":["doc-a"]}\n');
	await writeFile(
		join(directory, "doc-a", "export", "suite.xml"),
		"<suite/>\n",
	);
	const { stdout } = await run("tar", ["-c", "-f", "-", "-C", directory, "."], {
		encoding: "buffer",
		maxBuffer: 1 << 24,
	});
	return zstdCompressSync(Buffer.concat([stdout, Buffer.alloc(trailing)]));
}

const destinations = () => ({
	queue: join(scratch, "lane", "queue", "queue.json"),
	corpus: join(scratch, "corpus"),
});

function wait(...extra: string[]) {
	const to = destinations();
	return scripts.run("wait.mjs", [
		"--queue",
		NAMES.queue,
		"--corpus",
		NAMES.corpus,
		"--failed",
		NAMES.failed,
		"--queue-to",
		to.queue,
		"--corpus-to",
		to.corpus,
		"--poll",
		"0.02",
		...extra,
	]);
}

const listing = async (directory: string) =>
	(await readdir(directory, { recursive: true })).sort();

it("brings the queue and the corpus the run holds into place", async () => {
	service.put(NAMES.corpus, await corpus());
	service.put(NAMES.queue, Buffer.from(QUEUE));
	const result = await wait();
	expect([result.code, result.record.outcome]).toEqual([0, "fetched"]);
	const to = destinations();
	expect(await readFile(to.queue, "utf8")).toBe(QUEUE);
	expect(await listing(to.corpus)).toEqual([
		"doc-a",
		"doc-a/export",
		"doc-a/export/suite.xml",
		"index.json",
	]);
	expect(
		await readFile(join(to.corpus, "doc-a/export/suite.xml"), "utf8"),
	).toBe("<suite/>\n");
});

// tar exits once it reads the end-of-archive blocks, before it reads what follows them: far more than a pipe holds,
// so the unpack's last writes always find tar gone, whatever the machine's load.
it("unpacks a corpus whose tar ends before the bytes written after its end-of-archive blocks", async () => {
	service.put(NAMES.corpus, await corpus(4 << 20));
	service.put(NAMES.queue, Buffer.from(QUEUE));
	const result = await wait();
	expect([result.code, result.record.outcome]).toEqual([0, "fetched"]);
	expect(await listing(destinations().corpus)).toEqual([
		"doc-a",
		"doc-a/export",
		"doc-a/export/suite.xml",
		"index.json",
	]);
});

it("waits for a queue that arrives later, listing until it does", async () => {
	service.revealAfter(3);
	service.put(NAMES.corpus, await corpus());
	service.put(NAMES.queue, Buffer.from(QUEUE));
	const result = await wait();
	expect([result.code, result.record.listings]).toEqual([0, 4]);
	expect(await readFile(destinations().queue, "utf8")).toBe(QUEUE);
});

it("ends the wait when the emission failed, and changes nothing", async () => {
	service.put(NAMES.failed, Buffer.from("{}\n"));
	const result = await wait();
	expect([result.code, result.record.outcome]).toEqual([3, "emission-failed"]);
	await expect(readdir(join(scratch, "lane"))).rejects.toThrow();
});

it("takes the queue over the failure marker when the run holds both", async () => {
	service.put(NAMES.corpus, await corpus());
	service.put(NAMES.queue, Buffer.from(QUEUE));
	service.put(NAMES.failed, Buffer.from("{}\n"));
	expect((await wait()).code).toBe(0);
});

// How many listings fit before the deadline depends on how fast the machine answers; the test above counts them.
it("gives up once its deadline passes on the monotonic clock", async () => {
	const result = await wait("--deadline", "0.3");
	expect([result.code, result.record.outcome]).toEqual([4, "deadline"]);
	expect(result.record.waited).toBeGreaterThanOrEqual(0.3);
});

it("looks once with --once and leaves the destinations as they were", async () => {
	const result = await wait("--once");
	expect([result.code, result.record.listings]).toEqual([5, 1]);
	await expect(readdir(join(scratch, "lane"))).rejects.toThrow();
});

it("refuses a corpus whose bytes are not the digest the service lists", async () => {
	service.put(NAMES.corpus, await corpus(), `sha256:${"0".repeat(64)}`);
	service.put(NAMES.queue, Buffer.from(QUEUE));
	const result = await wait();
	expect([result.code, result.record.outcome]).toEqual([2, "failed"]);
	expect(result.stderr).toContain("whose sha256 is not");
	expect(await readdir(destinations().corpus)).toEqual([]);
	await expect(readFile(destinations().queue)).rejects.toThrow();
});

it("refuses to unpack into a corpus directory that already holds files", async () => {
	service.put(NAMES.corpus, await corpus());
	service.put(NAMES.queue, Buffer.from(QUEUE));
	await mkdir(destinations().corpus, { recursive: true });
	await writeFile(join(destinations().corpus, "left-over.json"), "{}\n");
	const result = await wait();
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("already holds 1 entries");
	await expect(readFile(destinations().queue)).rejects.toThrow();
});

it("fails loudly when the run holds the queue and no corpus", async () => {
	service.put(NAMES.queue, Buffer.from(QUEUE));
	const result = await wait();
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("no corpus proof-corpus-1.tar.zst");
});
