import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { test } from "../lib/fixtures";

let recording = false;
export function profilerCommand(args: string[]): string {
	const stateDir = process.env.NOVA_REACT_PROFILE_STATE_DIR;
	if (!stateDir) throw new Error("NOVA_REACT_PROFILE_STATE_DIR is missing.");
	const output = execFileSync(
		path.join(process.cwd(), "node_modules", ".bin", "agent-react-devtools"),
		[...args, `--state-dir=${stateDir}`],
		{ cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
	);
	if (args[0] === "profile" && args[1] === "start") recording = true;
	if (args[0] === "profile" && args[1] === "stop") recording = false;
	return output;
}

/** Stop a recording even when an interaction assertion failed before its stop. */
export function cleanupReactProfile(): void {
	if (recording) profilerCommand(["profile", "stop"]);
}

/** Each scenario exports distinct durable bytes and records them for the harness. */
export function exportReactProfile(): string {
	const configured = process.env.NOVA_REACT_PROFILE_OUTPUT;
	const manifest = process.env.NOVA_REACT_PROFILE_EXPORT_MANIFEST;
	if (!configured || !manifest)
		throw new Error("React profile output and export manifest are required.");
	const info = test.info();
	const identity = createHash("sha256")
		.update(`${info.testId}:${info.repeatEachIndex}:${info.retry}`)
		.digest("hex")
		.slice(0, 12);
	const parsed = path.parse(configured);
	const scenario = info.title
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	const output = path.resolve(
		parsed.dir,
		`${parsed.name}-${scenario}-${identity}.json`,
	);
	profilerCommand(["profile", "export", output]);
	appendFileSync(manifest, `${JSON.stringify(output)}\n`, "utf8");
	return output;
}
