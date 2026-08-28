import { spawn } from "node:child_process";
import { cp, mkdir, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import path from "node:path";

interface StatLike {
	isDirectory(): boolean;
	isFile(): boolean;
}

export interface StandaloneFileSystem {
	cp(
		source: string,
		destination: string,
		options: { recursive: true; force: true },
	): Promise<void>;
	mkdir(
		directory: string,
		options: { recursive: true },
	): Promise<string | undefined>;
	stat(target: string): Promise<StatLike>;
}

const nodeFileSystem: StandaloneFileSystem = { cp, mkdir, stat };

export interface StandalonePaths {
	readonly repositoryRoot: string;
	readonly standaloneRoot: string;
	readonly server: string;
	readonly publicSource: string;
	readonly publicDestination: string;
	readonly xpathWorkerSource: string;
	readonly staticSource: string;
	readonly staticDestination: string;
	readonly sharpSource: string;
	readonly sharpDestination: string;
}

export function standalonePaths(repositoryRoot: string): StandalonePaths {
	const resolvedRoot = path.resolve(repositoryRoot);
	const standaloneRoot = path.join(resolvedRoot, ".next", "standalone");
	return {
		repositoryRoot: resolvedRoot,
		standaloneRoot,
		server: path.join(standaloneRoot, "server.js"),
		publicSource: path.join(resolvedRoot, "public"),
		publicDestination: path.join(standaloneRoot, "public"),
		xpathWorkerSource: path.join(
			resolvedRoot,
			"public",
			"xpath-worker",
			"xpath-worker.js",
		),
		staticSource: path.join(resolvedRoot, ".next", "static"),
		staticDestination: path.join(standaloneRoot, ".next", "static"),
		sharpSource: path.join(resolvedRoot, "node_modules", "@img"),
		sharpDestination: path.join(standaloneRoot, "node_modules", "@img"),
	};
}

type RequiredArtifact = {
	readonly label: string;
	readonly kind: "directory" | "file";
	readonly target: string;
	readonly remedy: string;
};

type CopyStep = {
	readonly label: string;
	readonly source: string;
	readonly destination: string;
};

export function standalonePreparationPlan(repositoryRoot: string): {
	readonly paths: StandalonePaths;
	readonly requirements: readonly RequiredArtifact[];
	readonly copies: readonly CopyStep[];
} {
	const paths = standalonePaths(repositoryRoot);
	return {
		paths,
		requirements: [
			{
				label: "standalone server",
				kind: "file",
				target: paths.server,
				remedy: "Run `npm run build` first.",
			},
			{
				label: "public assets",
				kind: "directory",
				target: paths.publicSource,
				remedy: "Restore the repository's `public` directory.",
			},
			{
				label: "built XPath worker",
				kind: "file",
				target: paths.xpathWorkerSource,
				remedy: "Run `npm run build:xpath-worker` first.",
			},
			{
				label: "built static assets",
				kind: "directory",
				target: paths.staticSource,
				remedy: "Run `npm run build` first.",
			},
			{
				label: "sharp runtime assets",
				kind: "directory",
				target: paths.sharpSource,
				remedy: "Run `npm install` with optional dependencies enabled.",
			},
		],
		/* Match the production Docker runtime boundary exactly. The @img overlay
		 * must remain last: sharp loads libvips through dlopen, so Next's file
		 * tracer can copy the binding while omitting the shared library. */
		copies: [
			{
				label: "public assets",
				source: paths.publicSource,
				destination: paths.publicDestination,
			},
			{
				label: "built static assets",
				source: paths.staticSource,
				destination: paths.staticDestination,
			},
			{
				label: "sharp runtime assets",
				source: paths.sharpSource,
				destination: paths.sharpDestination,
			},
		],
	};
}

function artifactProblem(
	artifact: RequiredArtifact,
	detail: "is missing" | "has the wrong kind",
): string {
	return [
		`Cannot start the production standalone server: ${artifact.label} ${detail} at ${artifact.target}.`,
		artifact.remedy,
	].join(" ");
}

export async function prepareStandalone(
	repositoryRoot: string,
	fileSystem: StandaloneFileSystem = nodeFileSystem,
): Promise<StandalonePaths> {
	const plan = standalonePreparationPlan(repositoryRoot);

	/* Validate the complete source boundary before writing any placements, so a
	 * missing build or dependency cannot leave a half-prepared runtime tree. */
	for (const artifact of plan.requirements) {
		let info: StatLike;
		try {
			info = await fileSystem.stat(artifact.target);
		} catch (error) {
			throw new Error(artifactProblem(artifact, "is missing"), {
				cause: error,
			});
		}
		const hasExpectedKind =
			artifact.kind === "file" ? info.isFile() : info.isDirectory();
		if (!hasExpectedKind) {
			throw new Error(artifactProblem(artifact, "has the wrong kind"));
		}
	}

	for (const step of plan.copies) {
		await fileSystem.mkdir(path.dirname(step.destination), { recursive: true });
		await fileSystem.cp(step.source, step.destination, {
			recursive: true,
			force: true,
		});
	}

	return plan.paths;
}

export function standaloneServerInvocation(
	paths: StandalonePaths,
	environment: NodeJS.ProcessEnv = process.env,
	executable = process.execPath,
) {
	const port = environment.PORT?.trim() || "3000";
	const hostname = environment.HOSTNAME?.trim() || "0.0.0.0";
	return {
		command: executable,
		args: [paths.server],
		options: {
			cwd: paths.standaloneRoot,
			env: { ...environment, PORT: port, HOSTNAME: hostname },
			stdio: "inherit" as const,
		},
	};
}

export function childExitStatus(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	if (signal === null) return 1;
	const signalNumber = osConstants.signals[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}

export interface SupervisedChild {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: "error", listener: (error: Error) => void): unknown;
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): unknown;
}

export interface StandaloneSignalSource {
	off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
	on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
}

export async function superviseStandaloneChild(
	child: SupervisedChild,
	signalSource: StandaloneSignalSource = process,
): Promise<number> {
	const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
	const forward = (signal: NodeJS.Signals) => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill(signal);
		}
	};
	const handlers = forwardedSignals.map((signal) => {
		const handler = () => forward(signal);
		signalSource.on(signal, handler);
		return { signal, handler };
	});

	try {
		const result = await new Promise<{
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
		}>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		return childExitStatus(result.code, result.signal);
	} finally {
		for (const { signal, handler } of handlers) {
			signalSource.off(signal, handler);
		}
		/* A spawn error or parent-side exception must not strand a child that did
		 * start. Normal and signaled exits have already cleared exitCode/signalCode. */
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
}

export async function launchStandaloneServer(
	repositoryRoot: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const paths = await prepareStandalone(repositoryRoot);
	const invocation = standaloneServerInvocation(paths, environment);
	const child = spawn(invocation.command, invocation.args, invocation.options);
	return superviseStandaloneChild(child);
}
