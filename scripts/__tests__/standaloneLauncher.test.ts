import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	prepareStandalone,
	superviseStandaloneChild,
} from "../lib/standaloneLauncher.mts";

let root: string;
const assets = {
	"public/xpath-worker/xpath-worker.js": "worker bytes",
	"public/favicon.ico": "icon bytes",
	".next/static/chunks/app.js": "chunk bytes",
	"node_modules/@img/sharp-libvips/lib/libvips.so": "native library bytes",
};
async function put(relative: string, contents: string) {
	const target = path.join(root, relative);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, contents);
}
beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), "nova-standalone-")));
	for (const [name, bytes] of Object.entries(assets)) await put(name, bytes);
	await put(".next/standalone/server.js", "process.exit(0)");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

test("prepares real runtime assets, replaces traced copies, and preserves sources and unrelated output", async () => {
	await put(".next/standalone/public/favicon.ico", "stale icon");
	await put(
		".next/standalone/node_modules/@img/sharp-libvips/lib/libvips.so",
		"stale native library",
	);
	await put(
		".next/standalone/node_modules/retained.js",
		"retained tracing output",
	);
	await prepareStandalone(root);
	for (const [relative, bytes] of Object.entries(assets)) {
		expect(
			await readFile(path.join(root, ".next/standalone", relative), "utf8"),
		).toBe(bytes);
		expect(await readFile(path.join(root, relative), "utf8")).toBe(bytes);
	}
	expect(
		await readFile(
			path.join(root, ".next/standalone/node_modules/retained.js"),
			"utf8",
		),
	).toBe("retained tracing output");
	await prepareStandalone(root);
	expect(
		await readFile(
			path.join(root, ".next/standalone/public/favicon.ico"),
			"utf8",
		),
	).toBe("icon bytes");
});

test.each([
	[".next/standalone/server.js", "standalone server"],
	["public", "public assets"],
	["public/xpath-worker/xpath-worker.js", "built XPath worker"],
	[".next/static", "built static assets"],
	["node_modules/@img", "sharp runtime assets"],
])(
	"missing %s refuses before changing any existing runtime placement",
	async (relative, label) => {
		await put(".next/standalone/public/favicon.ico", "previous runtime");
		await rm(path.join(root, relative), { recursive: true, force: true });
		await expect(prepareStandalone(root)).rejects.toThrow(
			`${label} is missing`,
		);
		expect(
			await readFile(
				path.join(root, ".next/standalone/public/favicon.ico"),
				"utf8",
			),
		).toBe("previous runtime");
		await expect(
			readFile(path.join(root, ".next/standalone/.next/static/chunks/app.js")),
		).rejects.toMatchObject({ code: "ENOENT" });
	},
);

test.each([
	[".next/standalone/server.js", "standalone server", "directory"],
	["node_modules/@img", "sharp runtime assets", "file"],
])(
	"wrong artifact kind at %s refuses preparation",
	async (relative, label, kind) => {
		await rm(path.join(root, relative), { recursive: true, force: true });
		if (kind === "directory") await mkdir(path.join(root, relative));
		else await put(relative, "wrong kind");
		await expect(prepareStandalone(root)).rejects.toThrow(
			`${label} has the wrong kind`,
		);
		await expect(
			readFile(path.join(root, ".next/standalone/public/favicon.ico")),
		).rejects.toMatchObject({ code: "ENOENT" });
	},
);

const launcher = pathToFileURL(
	path.resolve("scripts/lib/standaloneLauncher.mts"),
).href;
function invocation(environment: NodeJS.ProcessEnv) {
	return {
		args: [
			"--input-type=module",
			"-e",
			`
import {launchStandaloneServer} from ${JSON.stringify(launcher)};
const signals = ['SIGINT', 'SIGTERM'];
const before = signals.map(s => process.listenerCount(s));
const status = await launchStandaloneServer(${JSON.stringify(root)});
console.log(JSON.stringify({status, before, after: signals.map(s => process.listenerCount(s))}));
process.exitCode = status;
`,
		],
		env: environment,
	};
}

test.each([
	{
		PORT: "",
		HOSTNAME: "",
		expectedPort: "3000",
		expectedHost: "0.0.0.0",
		code: 0,
	},
	{
		PORT: " 4102 ",
		HOSTNAME: " 127.0.0.1 ",
		expectedPort: "4102",
		expectedHost: "127.0.0.1",
		code: 23,
	},
])(
	"the real child receives its runtime cwd and environment, and returns exit $code",
	async ({ PORT, HOSTNAME, expectedPort, expectedHost, code }) => {
		await put(
			".next/standalone/server.js",
			`console.log(JSON.stringify({cwd: process.cwd(), port: process.env.PORT, hostname: process.env.HOSTNAME, custom: process.env.CUSTOM})); process.exit(${code});`,
		);
		const command = invocation({
			NODE_ENV: "test",
			PORT,
			HOSTNAME,
			CUSTOM: "kept",
		});
		const result = spawnSync(process.execPath, command.args, {
			env: command.env,
			encoding: "utf8",
			timeout: 5000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(code);
		const [child, parent] = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(child).toEqual({
			cwd: path.join(root, ".next/standalone"),
			port: expectedPort,
			hostname: expectedHost,
			custom: "kept",
		});
		expect(parent).toEqual({ status: code, before: [0, 0], after: [0, 0] });
	},
);

test.each(["SIGINT", "SIGTERM"] as const)(
	"the parent forwards OS %s, joins the child, and removes its listeners",
	async (signal) => {
		await put(
			".next/standalone/server.js",
			"console.log('READY'); setInterval(() => {}, 1000);",
		);
		const command = invocation({ NODE_ENV: "test" });
		const parent = spawn(process.execPath, command.args, {
			env: command.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const closed = once(parent, "close");
		const killGroup = () => {
			if (parent.pid) {
				try {
					process.kill(-parent.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		};
		const deadline = setTimeout(killGroup, 5000);
		let output = "";
		const ready = new Promise<void>((resolve) => {
			parent.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (output.includes("READY\n")) resolve();
			});
		});
		try {
			await Promise.race([
				ready,
				closed.then(() => {
					throw Error(`Parent exited before child ready: ${output}`);
				}),
			]);
			expect(output).toContain("READY");
			parent.kill(signal);
			const expected = signal === "SIGINT" ? 130 : 143;
			expect(await closed).toEqual([expected, null]);
			expect(JSON.parse(output.trim().split("\n").at(-1) ?? "")).toEqual({
				status: expected,
				before: [0, 0],
				after: [0, 0],
			});
		} finally {
			clearTimeout(deadline);
			killGroup();
			await closed;
		}
	},
);

test("a real spawn error rejects and removes supervision listeners", async () => {
	const before = [
		process.listenerCount("SIGINT"),
		process.listenerCount("SIGTERM"),
	];
	const child = spawn(path.join(root, "missing-executable"));
	const closed = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	await expect(superviseStandaloneChild(child)).rejects.toMatchObject({
		code: "ENOENT",
	});
	await closed;
	expect([
		process.listenerCount("SIGINT"),
		process.listenerCount("SIGTERM"),
	]).toEqual(before);
});
