import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";

it("enforces the provider boundary through the shipped linter, without replacing other import boundaries", () => {
	const directory = mkdtempSync(join(tmpdir(), "nova-provider-lint-"));
	try {
		copyFileSync("biome.json", join(directory, "biome.json"));
		const lint = (file: string, source: string) => {
			mkdirSync(dirname(join(directory, file)), { recursive: true });
			writeFileSync(join(directory, file), source);
			const result = spawnSync(
				process.execPath,
				[
					resolve("node_modules/@biomejs/biome/bin/biome"),
					"lint",
					"--only=style/noRestrictedImports",
					file,
				],
				{ cwd: directory, encoding: "utf8", timeout: 15_000 },
			);
			expect(result.error).toBeUndefined();
			return result;
		};
		for (const source of [
			'import { createOpenAI as bypass } from "@ai-sdk/openai"; export const provider = bypass();',
			'import { openai } from "@ai-sdk/openai"; export const model = openai("model");',
			'import * as sdk from "@ai-sdk/openai"; export const provider = sdk.createOpenAI();',
			'export { createOpenAI } from "@ai-sdk/openai";',
			'const sdk = await import("@ai-sdk/openai"); export const provider = sdk.createOpenAI();',
			'const sdk = require("@ai-sdk/openai"); module.exports = sdk.createOpenAI();',
		]) {
			for (const file of [
				"lib/bypass.ts",
				"app/bypass.ts",
				"components/bypass.ts",
			]) {
				const result = lint(file, source);
				expect(result.status, result.stderr).toBe(1);
				expect(result.stderr).toContain("Construct providers through");
			}
		}
		for (const file of [
			"lib/agent/openaiProvider.ts",
			"lib/agent/__tests__/wire.test.ts",
		]) {
			const result = lint(
				file,
				'export { createOpenAI } from "@ai-sdk/openai";',
			);
			expect(result.status, result.stderr).toBe(0);
		}
		const types = lint(
			"lib/types.ts",
			'export type { OpenAIProvider, OpenAIResponsesProviderOptions } from "@ai-sdk/openai";',
		);
		expect(types.status, types.stderr).toBe(0);
		for (const module of ["@/lib/doc/store", "@/lib/commcare"]) {
			const result = lint("components/bypass.ts", `export * from "${module}";`);
			expect(result.status, result.stderr).toBe(1);
			expect(result.stderr).toContain("lint/style/noRestrictedImports");
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
