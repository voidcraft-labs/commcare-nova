// Runs proof/ci's scripts as the workflow does, one process each, against a
// controlled artifact service, and joins every process a test started.

import { type ChildProcess, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { ArtifactService } from "./artifactService";

export const CI = resolve(import.meta.dirname, "..");

export interface Finished {
	/** The exit status the lane's server would read. */
	code: number | null;
	/** The script's record: the one JSON line on its standard output. */
	record: Record<string, unknown>;
	stdout: string;
	stderr: string;
}

export class Scripts {
	private readonly running = new Set<Promise<unknown>>();
	private readonly children = new Set<ChildProcess>();

	constructor(
		private readonly service: ArtifactService | undefined,
		private readonly scratch: string,
	) {}

	/**
	 * Runs `script` (claim.mjs, wait.mjs, runtime.mjs) with `args`, as job `job`
	 * of the service's run, or with `env` in place of the runtime variables.
	 */
	run(
		script: string,
		args: string[],
		{ job = "job-1", env }: { job?: string; env?: Record<string, string> } = {},
	): Promise<Finished> {
		const child = spawn(process.execPath, [join(CI, script), ...args], {
			env: {
				NODE_ENV: "test",
				PATH: process.env.PATH ?? "",
				TMPDIR: this.scratch,
				...(env ?? this.service?.env(job)),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.children.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		const finished = new Promise<Finished>((resolveRun, reject) => {
			child.on("error", reject);
			child.on("close", (code) => {
				this.children.delete(child);
				const lines = stdout.split("\n").filter(Boolean);
				let record: Record<string, unknown> = {};
				try {
					record = lines.length === 1 ? JSON.parse(lines[0]) : {};
				} catch {
					record = {};
				}
				resolveRun({ code, record, stdout, stderr });
			});
		});
		const tracked: Promise<void> = finished.then(
			() => {
				this.running.delete(tracked);
			},
			() => {
				this.running.delete(tracked);
			},
		);
		this.running.add(tracked);
		return finished;
	}

	/** Stops every script still running and waits for each to end. */
	async join(): Promise<void> {
		for (const child of this.children) child.kill("SIGKILL");
		await Promise.all([...this.running]);
	}
}
