import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { MODEL_PRICING, MODEL_ROLES } from "@/lib/models";

const role = z.strictObject({
	modelId: z.string().min(1),
	reasoningEffort: z.enum([
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]),
});
const models = z.strictObject({
	architect: role,
	peer: role,
	followUpEditor: role,
	documentExtractor: role,
	translator: role,
});
export type TrialRole = keyof z.infer<typeof models>;
const configSchema = z.strictObject({
	expectedModels: models,
	timeoutMinutes: z.number().int().min(1).max(90),
	maxRequests: z.number().int().min(1).max(1200),
	reviewPolicy: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("production") }),
		z.strictObject({
			kind: z.literal("diagnostic"),
			maxPeerRequests: z.number().int().min(80).max(600),
			maxArchitectRequests: z.number().int().min(180).max(800).default(400),
		}),
	]),
});
export type AuthoringTrialConfig = z.infer<typeof configSchema>;

/** Model changes belong in an explicit captured evaluation-checkout patch.
 * This declaration verifies that patch; it cannot switch production models. */
export function parseTrialConfig(value: unknown): AuthoringTrialConfig {
	const config = configSchema.parse(value);
	for (const name of Object.keys(MODEL_ROLES) as TrialRole[]) {
		const expected = config.expectedModels[name];
		const actual = MODEL_ROLES[name];
		if (
			expected.modelId !== actual.modelId ||
			expected.reasoningEffort !== actual.reasoningEffort
		)
			throw new Error(`Trial configuration does not match installed ${name}.`);
		if (!Object.hasOwn(MODEL_PRICING, actual.modelId))
			throw new Error(`No trial rate card for ${actual.modelId}.`);
	}
	return config;
}

export async function loadTrialConfig(
	file: string | undefined,
	kind: "architect" | "editor",
): Promise<AuthoringTrialConfig> {
	return parseTrialConfig(
		file
			? JSON.parse(await readFile(resolve(file), "utf8"))
			: {
					expectedModels: MODEL_ROLES,
					timeoutMinutes: kind === "architect" ? 30 : 15,
					maxRequests: kind === "architect" ? 400 : 80,
					reviewPolicy: { kind: "production" },
				},
	);
}

const wireSchema = z.object({
	model: z.string(),
	reasoning: z.object({ effort: z.string() }),
	store: z.literal(false),
	service_tier: z.literal("default"),
	max_output_tokens: z.number().int().positive().max(128_000),
});
export function verifyTrialWire(
	body: string,
	config: AuthoringTrialConfig,
	roleName: TrialRole,
) {
	const request = wireSchema.parse(JSON.parse(body));
	const expected = config.expectedModels[roleName];
	if (
		request.model !== expected.modelId ||
		request.reasoning.effort !== expected.reasoningEffort
	)
		throw new Error(`Provider request does not match trial role ${roleName}.`);
	return request;
}

export async function trialCodeIdentity(requireFrozen = false) {
	const run = promisify(execFile);
	if (requireFrozen) {
		const [{ stdout: changed }, { stdout: untracked }] = await Promise.all([
			run("git", ["diff", "HEAD", "--name-only", "-z"]),
			run("git", ["ls-files", "--others", "--exclude-standard", "-z"]),
		]);
		if (
			untracked ||
			changed.split("\0").some((path) => path && path !== "lib/models.ts")
		)
			throw new Error(
				"Paid trials require committed code; only the captured model-configuration patch may be uncommitted.",
			);
	}
	const [{ stdout: head }, { stdout: patch }] = await Promise.all([
		run("git", ["rev-parse", "HEAD"]),
		run("git", ["diff", "HEAD", "--binary", "--no-ext-diff"], {
			maxBuffer: 32 * 1024 * 1024,
		}),
	]);
	return {
		head: head.trim(),
		trackedPatchSha256: createHash("sha256").update(patch).digest("hex"),
		patch,
	};
}

export async function verifyTrialResume(
	directory: string,
	current: {
		config: AuthoringTrialConfig;
		code: Awaited<ReturnType<typeof trialCodeIdentity>>;
		ledger: string;
	},
) {
	const prior = JSON.parse(
		await readFile(resolve(directory, "trial-config.json"), "utf8"),
	);
	if (JSON.stringify(prior) !== JSON.stringify(current))
		throw new Error(
			"Resume requires the original code, role configuration, policy, and ledger.",
		);
}
