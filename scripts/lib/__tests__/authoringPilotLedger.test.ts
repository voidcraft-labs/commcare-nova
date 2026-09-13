import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { completedPilotCharge, withPilotLedger } from "../authoringPilotLedger";

it("keeps one owner across path aliases and releases ownership after failure", async () => {
	const directory = await mkdtemp(join(tmpdir(), "nova-pilot-ledger-"));
	const path = join(directory, "ledger.json");
	const alias = join(directory, "alias.json");
	try {
		await writeFile(path, '{"reserved":0}');
		await symlink(path, alias);
		await expect(
			withPilotLedger(path, async (file) => {
				await file.save({ reserved: 1 });
				await expect(
					withPilotLedger(alias, async () => {
						throw new Error("A second runner acquired the ledger.");
					}),
				).rejects.toMatchObject({ code: "EEXIST" });
				throw new Error("Trial failed after reserving its request.");
			}),
		).rejects.toThrow("Trial failed after reserving its request.");
		await withPilotLedger(alias, async (file) => {
			expect(JSON.parse(await readFile(file.path, "utf8"))).toEqual({
				reserved: 1,
			});
			await file.save({ reserved: 2 });
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ reserved: 2 });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("keeps the reservation for absent or invalid provider usage, including partial usage", () => {
	for (const usage of [
		{},
		{ inputTokens: 100 },
		{ outputTokens: 20 },
		{ inputTokens: Number.NaN, outputTokens: 20 },
		{ inputTokens: 100, outputTokens: Number.POSITIVE_INFINITY },
		{ inputTokens: -1, outputTokens: 20 },
	])
		expect(completedPilotCharge("gpt-5.6-luna", usage, 1)).toEqual({
			status: "completed-unmetered",
			estimatedUsd: 1,
		});
	// A reported zero-input program continuation is distinct from missing usage.
	expect(
		completedPilotCharge(
			"gpt-5.6-luna",
			{ inputTokens: 0, outputTokens: 1000 },
			1,
		),
	).toEqual({ status: "completed", estimatedUsd: expect.closeTo(0.0015, 10) });
});
