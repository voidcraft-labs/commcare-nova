// proof/ci/pull.mjs pulls a proof shard's image and Postgres, trying a pull
// again only where the registry's answer can change (mirror.gcr.io's shared
// per-minute quota, a server error, a connection lost on the way). The
// plausible failures are a throttled pull that fails the shard on its first
// refusal, and the opposite: a refusal no wait changes (a digest the registry
// does not hold) that waits out every pause before failing, on every shard,
// or that waits out the other pull's pause before the shard can fail.
// A controlled `docker` on PATH answers each pull as its script says, and
// records what it was asked, so the tries are counted from the calls made.

import { type ExecFileException, execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CI } from "./scripts";

const IMAGE = `ghcr.io/voidcraft-labs/commcare-nova-proof@sha256:${"a".repeat(64)}`;
const THROTTLED =
	"Error response from daemon: toomanyrequests: Quota exceeded for quota metric 'Requests per project in the US multi-region' and limit 'Requests per project in the US multi-region per minute'";
const UNKNOWN =
	"Error response from daemon: manifest for mirror.gcr.io/library/postgres@sha256:0000 not found: manifest unknown";

// Answers `docker pull` as the image and `docker compose ... pull` as
// Postgres, each from its own list: line n is the nth try's answer, `ok` or
// what the registry says before the pull fails.
const DOCKER = `#!/bin/sh
kind=image
[ "$1" = compose ] && kind=postgres
echo "$kind $* PROOF_IMAGE=$PROOF_IMAGE" >> "$FAKE/calls"
count=$(grep -c "^$kind " "$FAKE/calls")
answer=$(sed -n "\${count}p" "$FAKE/$kind")
[ "$answer" = ok ] && exit 0
echo "$answer" >&2
exit 1
`;

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "proof-ci-pull-"));
	await mkdir(join(scratch, "bin"));
	await mkdir(join(scratch, "proof"));
	await writeFile(join(scratch, "bin", "docker"), DOCKER);
	await chmod(join(scratch, "bin", "docker"), 0o755);
	await writeFile(
		join(scratch, "proof", "image.lock"),
		JSON.stringify({ image: IMAGE }),
	);
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function pull(
	answers: { image: string[]; postgres: string[] },
	pauses = "0,0,0",
) {
	await writeFile(join(scratch, "image"), `${answers.image.join("\n")}\n`);
	await writeFile(
		join(scratch, "postgres"),
		`${answers.postgres.join("\n")}\n`,
	);
	const finished = await new Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		execFile(
			process.execPath,
			[join(CI, "pull.mjs"), "--pauses", pauses],
			{
				cwd: scratch,
				env: {
					NODE_ENV: "test",
					PATH: `${join(scratch, "bin")}:${process.env.PATH ?? ""}`,
					FAKE: scratch,
				},
			},
			(error: ExecFileException | null, stdout: string, stderr: string) => {
				const code = error ? ((error as { code?: number }).code ?? -1) : 0;
				resolve({ code, stdout, stderr });
			},
		);
	});
	const calls = (await readFile(join(scratch, "calls"), "utf8"))
		.split("\n")
		.filter(Boolean);
	return {
		...finished,
		image: calls.filter((call) => call.startsWith("image ")),
		postgres: calls.filter((call) => call.startsWith("postgres ")),
	};
}

it("pulls the locked image and the compose Postgres, each once when the registry answers", async () => {
	const run = await pull({ image: ["ok"], postgres: ["ok"] });
	expect(run.code).toBe(0);
	expect(run.image).toEqual([`image pull --quiet ${IMAGE} PROOF_IMAGE=`]);
	expect(run.postgres).toEqual([
		`postgres compose -f proof/compose.yaml pull --quiet postgres PROOF_IMAGE=${IMAGE}`,
	]);
});

it("tries a throttled pull again until the registry answers", async () => {
	const run = await pull({
		image: ["ok"],
		postgres: [
			THROTTLED,
			"Get https://mirror.gcr.io/v2/: net/http: TLS handshake timeout",
			"ok",
		],
	});
	expect(run.code).toBe(0);
	expect(run.postgres).toHaveLength(3);
	expect(run.stdout).toContain("Pulled the proof lane's Postgres on try 3.");
});

it("fails a refusal no wait changes on its first try, in the registry's words", async () => {
	const run = await pull({ image: ["ok"], postgres: [UNKNOWN, "ok"] });
	expect(run.code).toBe(1);
	expect(run.postgres).toHaveLength(1);
	expect(run.stderr).toContain("manifest unknown");
	expect(run.stderr).toContain("tried once");
});

it("fails after four throttled tries, with the last answer", async () => {
	const run = await pull({
		image: ["ok"],
		postgres: [THROTTLED, THROTTLED, THROTTLED, THROTTLED, "ok"],
	});
	expect(run.code).toBe(1);
	expect(run.postgres).toHaveLength(4);
	expect(run.stderr).toContain("failed 4 times");
	expect(run.stderr).toContain("toomanyrequests");
});

it("stops the other pull's wait for its next try once one pull fails for good", async () => {
	// A pause no test could wait out: the run ends only if the wait is stopped.
	const run = await pull(
		{ image: [UNKNOWN, "ok"], postgres: [THROTTLED, "ok"] },
		"3600,3600,3600",
	);
	expect(run.code).toBe(1);
	expect(run.image).toHaveLength(1);
	expect(run.postgres).toHaveLength(1);
	expect(run.stderr).toContain("manifest unknown");
	expect(run.stderr).toContain(
		"Stopped trying the proof lane's Postgres again",
	);
});
