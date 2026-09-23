import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import { captureModelRequests } from "@/lib/agent/anatomy/requestCapture";
import {
	migrateTrialLedger,
	scanTrialLedger,
} from "../authoringLedgerMigration";
import {
	completedPilotCharge,
	pilotReservation,
	readPilotLedger,
	reconcilePilotLedger,
	standardPilotTransport,
} from "../authoringPilotLedger";
import { priorTrialRuns, remainingTrialBudget } from "../authoringTrialHistory";

const completed = {
	runId: "initial",
	model: "gpt-5.6-sol",
	status: "completed",
	reservedUsd: 10,
	estimatedUsd: 0.5,
	usage: {
		inputTokens: 100_000,
		outputTokens: 0,
		inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
	},
};
const pending = { runId: "resumed", status: "pending", reservedUsd: 12 };
const legacy = {
	ceilingUsd: 100,
	targetUsd: 100,
	estimatedSpentUsd: 12.5,
	calls: [completed, pending],
};

it("settles reported usage once and retains unknown charges without resetting recovered trial spend", () => {
	const result = reconcilePilotLedger(legacy, 150);
	expect(result.ledger.estimatedSpentUsd).toBe(12.4);
	expect(result.removedMarginUsd).toBeCloseTo(0.1);
	expect(result.ledger.calls[1]).toEqual(pending);
	const unrelated = { runId: "other", status: "completed", estimatedUsd: 100 };
	const ledger = readPilotLedger({
		...result.ledger,
		estimatedSpentUsd: 112.4,
		calls: [...result.ledger.calls, unrelated],
	});
	expect(
		remainingTrialBudget(ledger, ["initial", "resumed", "next"], 30, "design"),
	).toBeCloseTo(17.6);
	expect(
		remainingTrialBudget(
			{ ...ledger, ceilingUsd: 120 },
			["initial", "resumed"],
			30,
			"design",
		),
	).toBeCloseTo(7.6);
	expect(() => readPilotLedger(legacy)).toThrow();
	expect(() => reconcilePilotLedger(result.ledger, 150)).toThrow();
	expect(() =>
		reconcilePilotLedger({ ...legacy, estimatedSpentUsd: 0 }, 150),
	).toThrow("total");
	expect(() =>
		readPilotLedger({ ...result.ledger, estimatedSpentUsd: 0 }),
	).toThrow("total");
	expect(() => reconcilePilotLedger(legacy, 10)).toThrow("ceiling");
});

it("bounds each model at its highest context and cache rates and refuses unknown models", () => {
	expect(pilotReservation("gpt-5.6-sol", 300_000, 32_000)).toBe(3.96);
	expect(pilotReservation("gpt-6-sol", 300_000, 32_000)).toBe(1.98);
	expect(pilotReservation("gpt-6-luna", 300_000, 32_000)).toBe(0.099);
	expect(() => pilotReservation("unknown", 1, 1)).toThrow("rate card");
	expect(() => pilotReservation("gpt-6-sol", -1, 1)).toThrow("bound");
	expect(
		completedPilotCharge("unknown", { inputTokens: 1, outputTokens: 1 }, 3),
	).toEqual({ status: "completed-unmetered", estimatedUsd: 3 });
});

it("requires a reviewed unchanged source, preserves it and refuses destination overwrite", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nova-budget-migration-"));
	try {
		const source = join(directory, "old.json"),
			destination = join(directory, "new.json");
		const bytes = JSON.stringify(legacy);
		await writeFile(source, bytes);
		const scan = await scanTrialLedger(source, 150);
		expect(scan.unresolvedCalls).toBe(1);
		await writeFile(source, `${bytes}\n`);
		await expect(
			migrateTrialLedger(source, destination, 150, scan.sourceSha256),
		).rejects.toThrow("changed");
		await expect(readFile(destination)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await writeFile(source, bytes);
		await migrateTrialLedger(source, destination, 150, scan.sourceSha256);
		expect(await readFile(source, "utf8")).toBe(bytes);
		expect(
			readPilotLedger(JSON.parse(await readFile(destination, "utf8"))),
		).toEqual(scan.ledger);
		await expect(
			migrateTrialLedger(source, destination, 150, scan.sourceSha256),
		).rejects.toMatchObject({ code: "EEXIST" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("recovers all run identities and refuses a different app or a cyclic ancestry", async () => {
	const initial = await mkdtemp(join(tmpdir(), "nova-budget-initial-"));
	const resumed = await mkdtemp(join(tmpdir(), "nova-budget-resume-"));
	const identity = { appId: "app", designSessionId: "design" };
	try {
		await writeFile(
			join(initial, "run.json"),
			JSON.stringify({ ...identity, runId: "initial" }),
		);
		await writeFile(
			join(resumed, "run.json"),
			JSON.stringify({ ...identity, runId: "resumed", resumedFrom: initial }),
		);
		expect(await priorTrialRuns(resumed, "app", "design")).toEqual([
			"resumed",
			"initial",
		]);
		await expect(
			priorTrialRuns(resumed, "another-app", "design"),
		).rejects.toThrow();
		await writeFile(
			join(initial, "run.json"),
			JSON.stringify({ ...identity, runId: "initial", resumedFrom: resumed }),
		);
		await expect(priorTrialRuns(resumed, "app", "design")).rejects.toThrow(
			"cycle",
		);
	} finally {
		await rm(initial, { recursive: true, force: true });
		await rm(resumed, { recursive: true, force: true });
	}
});

it("captures the exact Standard request sent to the provider and stops before dispatch when reservation fails", async () => {
	const received: Array<{ body: string; authorization: string | undefined }> =
		[];
	await withSocketHttpPeer(
		"api.openai.com",
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			request.on("end", () => {
				received.push({
					body: Buffer.concat(chunks).toString(),
					authorization: request.headers.authorization,
				});
				response.writeHead(200).end("ok");
			});
		},
		async () => {
			let captured = "";
			const transport = standardPilotTransport(
				captureModelRequests(fetch, async (request) => {
					captured = request.body;
				}),
			);
			const body = JSON.stringify({
				model: "gpt-6-sol",
				input: "test",
				service_tier: "priority",
			});
			const response = await transport("https://api.openai.com/v1/responses", {
				method: "POST",
				headers: {
					Authorization: "Bearer synthetic",
					"Content-Length": String(Buffer.byteLength(body)),
				},
				body,
			});
			expect(await response.text()).toBe("ok");
			expect(received).toEqual([
				{ body: captured, authorization: "Bearer synthetic" },
			]);
			expect(JSON.parse(captured)).toEqual({
				model: "gpt-6-sol",
				input: "test",
				service_tier: "default",
			});
			const refusing = standardPilotTransport(
				captureModelRequests(fetch, async () => {
					throw new Error("No budget");
				}),
			);
			await expect(
				refusing("https://api.openai.com/v1/responses", {
					method: "POST",
					body,
				}),
			).rejects.toThrow("No budget");
			expect(received).toHaveLength(1);
		},
	);
});

it("counts sibling continuations even when recovery selects an older checkpoint", () => {
	const ledger = readPilotLedger({
		accountingVersion: 2,
		ceilingUsd: 150,
		targetUsd: 150,
		estimatedSpentUsd: 29,
		calls: [
			{ runId: "initial", status: "completed", estimatedUsd: 6 },
			{
				runId: "recovery-one",
				trialId: "design",
				status: "pending",
				reservedUsd: 20,
			},
			{
				runId: "sibling-completed",
				trialId: "design",
				status: "completed",
				estimatedUsd: 3,
			},
		],
	});
	expect(
		remainingTrialBudget(ledger, ["initial", "recovery-two"], 30, "design"),
	).toBe(1);
});
