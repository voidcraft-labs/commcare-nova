import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("rejects unfinished promises with the shipped Biome configuration", () => {
	const fixture = mkdtempSync(path.join(tmpdir(), "nova-test-lint-"));
	try {
		copyFileSync("biome.json", path.join(fixture, "biome.json"));
		const lint = (source: string) => {
			writeFileSync(path.join(fixture, "ownership.test.ts"), source);
			return spawnSync(
				process.execPath,
				[
					path.resolve("node_modules/@biomejs/biome/bin/biome"),
					"lint",
					"ownership.test.ts",
				],
				{ cwd: fixture, encoding: "utf8", timeout: 15_000 },
			);
		};
		const valid = lint(
			"async function task(): Promise<void> { await Promise.resolve(); }\nawait task();\n",
		);
		expect(valid.error).toBeUndefined();
		expect(valid.status, valid.stderr).toBe(0);
		const invalid = lint(
			"async function task(): Promise<void> { await Promise.resolve(); }\ntask();\n",
		);
		expect(invalid.error).toBeUndefined();
		expect(invalid.status).toBe(1);
		expect(invalid.stderr).toContain("lint/nursery/noFloatingPromises");
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
