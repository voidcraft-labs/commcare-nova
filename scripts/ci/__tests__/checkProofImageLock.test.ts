import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const run = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "check-proof-image-lock.mjs");
const DIGEST = `ghcr.io/voidcraft-labs/commcare-nova-proof@sha256:${"a".repeat(64)}`;
const HQ = "f57e85e029130ceb576ea6d0f389b744509de6c9";
const CORE = "8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "proof-image-lock-"));
	await mkdir(join(root, "proof"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function write(pins: object, lock: object) {
	await writeFile(join(root, "proof/pins.json"), JSON.stringify(pins));
	await writeFile(join(root, "proof/image.lock"), JSON.stringify(lock));
}

async function check() {
	try {
		const { stdout } = await run(process.execPath, [SCRIPT, root]);
		return { code: 0, output: stdout };
	} catch (error) {
		const failure = error as { code: number; stderr: string };
		return { code: failure.code, output: failure.stderr };
	}
}

const pins = {
	"commcare-hq": { commit: HQ },
	"commcare-core": { commit: CORE },
};

it("passes when the locked image was built from exactly the pinned commits", async () => {
	await write(pins, {
		image: DIGEST,
		pins: { "commcare-hq": HQ, "commcare-core": CORE },
	});
	expect(await check()).toMatchObject({ code: 0 });
});

it("fails naming each upstream whose pin moved without a rebuilt image", async () => {
	await write(
		{ ...pins, "commcare-android": { commit: "f".repeat(40) } },
		{
			image: DIGEST,
			pins: { "commcare-hq": HQ, "commcare-core": "0".repeat(40) },
		},
	);
	const result = await check();
	expect(result.code).toBe(1);
	expect(result.output).toContain(
		`commcare-core: proof/pins.json pins ${CORE}`,
	);
	expect(result.output).toContain("commcare-android: proof/pins.json pins");
	expect(result.output).not.toContain("commcare-hq:");
});

it("fails for an image reference that is not pinned by digest", async () => {
	await write(pins, {
		image: "ghcr.io/voidcraft-labs/commcare-nova-proof:latest",
		pins: { "commcare-hq": HQ, "commcare-core": CORE },
	});
	const result = await check();
	expect(result.code).toBe(1);
	expect(result.output).toContain("not a digest-pinned ghcr.io reference");
});
