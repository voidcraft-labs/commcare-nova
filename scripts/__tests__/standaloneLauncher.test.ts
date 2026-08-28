import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	childExitStatus,
	prepareStandalone,
	type StandaloneFileSystem,
	type StandaloneSignalSource,
	type SupervisedChild,
	standalonePaths,
	standalonePreparationPlan,
	standaloneServerInvocation,
	superviseStandaloneChild,
} from "../lib/standaloneLauncher.mts";

const ROOT = path.resolve("/workspace/commcare-nova");

function fakeFileSystem(
	plan: ReturnType<typeof standalonePreparationPlan>,
	missing?: string,
) {
	const kinds = new Map(
		plan.requirements.map((artifact) => [artifact.target, artifact.kind]),
	);
	const fileSystem: StandaloneFileSystem = {
		stat: vi.fn(async (target) => {
			if (target === missing || !kinds.has(target)) {
				throw new Error("ENOENT");
			}
			const kind = kinds.get(target);
			return {
				isDirectory: () => kind === "directory",
				isFile: () => kind === "file",
			};
		}),
		mkdir: vi.fn(async () => undefined),
		cp: vi.fn(async () => undefined),
	};
	return fileSystem;
}

function supervisedFixture() {
	const state: {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
	} = { exitCode: null, signalCode: null };
	let onError: ((error: Error) => void) | undefined;
	let onExit:
		| ((code: number | null, signal: NodeJS.Signals | null) => void)
		| undefined;
	const child = {
		get exitCode() {
			return state.exitCode;
		},
		get signalCode() {
			return state.signalCode;
		},
		kill: vi.fn(() => true),
		once: vi.fn(
			(
				event: "error" | "exit",
				listener:
					| ((error: Error) => void)
					| ((code: number | null, signal: NodeJS.Signals | null) => void),
			) => {
				if (event === "error") {
					onError = listener as (error: Error) => void;
				} else {
					onExit = listener as (
						code: number | null,
						signal: NodeJS.Signals | null,
					) => void;
				}
			},
		),
	} as unknown as SupervisedChild;
	const signalHandlers = new Map<"SIGINT" | "SIGTERM", () => void>();
	const signalSource: StandaloneSignalSource = {
		on: vi.fn((signal, handler) => signalHandlers.set(signal, handler)),
		off: vi.fn((signal, handler) => {
			if (signalHandlers.get(signal) === handler) {
				signalHandlers.delete(signal);
			}
		}),
	};
	return {
		child,
		signalSource,
		signalHandlers,
		state,
		error: (error: Error) => onError?.(error),
		exit: (code: number | null, signal: NodeJS.Signals | null) =>
			onExit?.(code, signal),
	};
}

describe("standalone production launcher", () => {
	it("pins every runtime path under the actual checkout root", () => {
		const paths = standalonePaths(ROOT);
		expect(paths).toEqual({
			repositoryRoot: ROOT,
			standaloneRoot: path.join(ROOT, ".next", "standalone"),
			server: path.join(ROOT, ".next", "standalone", "server.js"),
			publicSource: path.join(ROOT, "public"),
			publicDestination: path.join(ROOT, ".next", "standalone", "public"),
			xpathWorkerSource: path.join(
				ROOT,
				"public",
				"xpath-worker",
				"xpath-worker.js",
			),
			staticSource: path.join(ROOT, ".next", "static"),
			staticDestination: path.join(
				ROOT,
				".next",
				"standalone",
				".next",
				"static",
			),
			sharpSource: path.join(ROOT, "node_modules", "@img"),
			sharpDestination: path.join(
				ROOT,
				".next",
				"standalone",
				"node_modules",
				"@img",
			),
		});
	});

	it("validates everything first, then overlays public, static, and sharp in Docker order", async () => {
		const plan = standalonePreparationPlan(ROOT);
		const fileSystem = fakeFileSystem(plan);

		await expect(prepareStandalone(ROOT, fileSystem)).resolves.toEqual(
			plan.paths,
		);
		expect(fileSystem.stat).toHaveBeenCalledTimes(plan.requirements.length);
		expect(fileSystem.mkdir).toHaveBeenCalledTimes(3);
		expect(fileSystem.cp).toHaveBeenNthCalledWith(
			1,
			plan.paths.publicSource,
			plan.paths.publicDestination,
			{ recursive: true, force: true },
		);
		expect(fileSystem.cp).toHaveBeenNthCalledWith(
			2,
			plan.paths.staticSource,
			plan.paths.staticDestination,
			{ recursive: true, force: true },
		);
		expect(fileSystem.cp).toHaveBeenNthCalledWith(
			3,
			plan.paths.sharpSource,
			plan.paths.sharpDestination,
			{ recursive: true, force: true },
		);
	});

	it.each([
		["standalone server", "Run `npm run build` first."],
		["public assets", "Restore the repository's `public` directory."],
		["built XPath worker", "Run `npm run build:xpath-worker` first."],
		["built static assets", "Run `npm run build` first."],
		[
			"sharp runtime assets",
			"Run `npm install` with optional dependencies enabled.",
		],
	])("fails before copying when %s are absent", async (label, remedy) => {
		const plan = standalonePreparationPlan(ROOT);
		const missing = plan.requirements.find(
			(artifact) => artifact.label === label,
		);
		if (missing === undefined) throw new Error(`Missing fixture: ${label}`);
		const fileSystem = fakeFileSystem(plan, missing.target);

		await expect(prepareStandalone(ROOT, fileSystem)).rejects.toThrow(
			`${label} is missing at ${missing.target}. ${remedy}`,
		);
		expect(fileSystem.mkdir).not.toHaveBeenCalled();
		expect(fileSystem.cp).not.toHaveBeenCalled();
	});

	it("runs canonical server.js with explicit runtime host/port defaults", () => {
		const paths = standalonePaths(ROOT);
		expect(
			standaloneServerInvocation(
				paths,
				{ NODE_ENV: "test", CUSTOM: "kept" },
				"/node",
			),
		).toEqual({
			command: "/node",
			args: [paths.server],
			options: {
				cwd: paths.standaloneRoot,
				env: {
					NODE_ENV: "test",
					CUSTOM: "kept",
					PORT: "3000",
					HOSTNAME: "0.0.0.0",
				},
				stdio: "inherit",
			},
		});
	});

	it("propagates child failures and conventional signal statuses", () => {
		expect(childExitStatus(0, null)).toBe(0);
		expect(childExitStatus(23, null)).toBe(23);
		expect(childExitStatus(null, "SIGINT")).toBe(130);
		expect(childExitStatus(null, "SIGTERM")).toBe(143);
		expect(childExitStatus(null, null)).toBe(1);
	});

	it("forwards termination, propagates the child status, and removes handlers", async () => {
		const fixture = supervisedFixture();
		const result = superviseStandaloneChild(
			fixture.child,
			fixture.signalSource,
		);

		fixture.signalHandlers.get("SIGTERM")?.();
		expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
		fixture.state.signalCode = "SIGTERM";
		fixture.exit(null, "SIGTERM");

		await expect(result).resolves.toBe(143);
		expect(fixture.signalHandlers.size).toBe(0);
	});

	it("terminates a possibly-started child when supervision errors", async () => {
		const fixture = supervisedFixture();
		const result = superviseStandaloneChild(
			fixture.child,
			fixture.signalSource,
		);

		fixture.error(new Error("spawn failed"));

		await expect(result).rejects.toThrow("spawn failed");
		expect(fixture.child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(fixture.signalHandlers.size).toBe(0);
	});
});
