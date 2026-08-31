import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/config/commcare-hq-feature-flags.json";

const PUBLIC_ROOTS = [
	"components",
	"content/docs",
	"lib/automations",
	"lib/deployment",
	"lib/mcp",
	"lib/publish",
	"app/api/compile",
	"app/api/commcare",
] as const;

const PUBLIC_SOURCE_EXTENSIONS = new Set([".md", ".mdx", ".ts", ".tsx"]);

const RETIRED_PUBLIC_NAMES = [
	"get_app_hq_feature_flags",
	"feature_flag_requirements",
	"nova_hq_feature_flag_requirements",
	"nova/featureFlagRequirements",
	"X-Nova-Hq-Feature-Flag-Report",
] as const;

function extension(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? "" : path.slice(dot);
}

function publicSourceFiles(path: string): string[] {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		if (
			entry.name === "__tests__" ||
			entry.name === "node_modules" ||
			entry.name === "CLAUDE.md"
		) {
			return [];
		}
		const child = join(path, entry.name);
		if (entry.isDirectory()) return publicSourceFiles(child);
		return PUBLIC_SOURCE_EXTENSIONS.has(extension(entry.name)) ? [child] : [];
	});
}

function escaped(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match one private token, but not the same text inside a larger identifier. */
function privateTokenPattern(value: string): RegExp {
	return new RegExp(`(^|[^A-Za-z0-9_])${escaped(value)}([^A-Za-z0-9_]|$)`);
}

describe("project-space compatibility public boundary", () => {
	it("keeps private HQ settings and retired report names out of public surfaces", () => {
		const privateTokens = [
			...manifest.flags.flatMap((flag) => [flag.slug, flag.symbol]),
			"cc-index-case-search-results",
			"CASE_UPDATES_UCR_FILTERS",
			"RUN_AUTO_CASE_UPDATES_ON_SAVE",
		];
		const violations: string[] = [];

		for (const root of PUBLIC_ROOTS) {
			for (const path of publicSourceFiles(join(process.cwd(), root))) {
				const source = readFileSync(path, "utf8");
				for (const token of privateTokens) {
					if (privateTokenPattern(token).test(source)) {
						violations.push(
							`${relative(process.cwd(), path)} exposes ${token}`,
						);
					}
				}
				for (const retiredName of RETIRED_PUBLIC_NAMES) {
					if (source.includes(retiredName)) {
						violations.push(
							`${relative(process.cwd(), path)} retains ${retiredName}`,
						);
					}
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
