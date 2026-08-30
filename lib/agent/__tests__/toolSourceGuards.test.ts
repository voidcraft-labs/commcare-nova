/**
 * Structural bypass guards for the shared tool surface.
 *
 * A shared tool body reaches persistence ONLY through its
 * `ToolInvocationContext` (`applyBatch` / `applyStages`) — the workspace owns
 * the gate and the canonical boundary. A tool that imported the canonical
 * writers, the commit kernel, or an external write service directly could
 * bypass both, so those imports fail here at source level. The narrow
 * exceptions are declared capability adapters: a file may import an external
 * service exactly when the registry policy grants its tools the matching
 * runtime capability.
 *
 * TypeScript already keeps `recordMutations` off the invocation context;
 * `workspace/__tests__/canonicalWorkspace.test.ts` proves the runtime object
 * matches.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARED_TOOL_REGISTRY } from "../sharedToolRegistry";

const TOOLS_ROOT = join(__dirname, "..", "tools");

/** Every non-test .ts file under lib/agent/tools/. */
function toolSourceFiles(dir = TOOLS_ROOT): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...toolSourceFiles(full));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Every module specifier a source reaches — static `import`/`export from`,
 *  dynamic `import("...")`, and `require("...")`, so a runtime-loaded writer
 *  cannot slip past the ban. */
function importedSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const pattern =
		/from\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1] ?? match[2] ?? match[3];
		if (specifier !== undefined) specifiers.push(specifier);
	}
	return specifiers;
}

interface ForbiddenImportRule {
	/** Human name for the failure message. */
	readonly what: string;
	readonly matches: (specifier: string) => boolean;
	/**
	 * Files (relative to lib/agent/tools) allowed to hold this import, each
	 * justified by a registry capability its tool declares — checked below.
	 */
	readonly allowedFiles: readonly string[];
	/** The capability that justifies the exception, per allowed file's tool. */
	readonly justifyingCapability?: string;
}

const RULES: readonly ForbiddenImportRule[] = [
	{
		what: "the canonical commit kernel",
		matches: (s) => s.includes("db/canonicalCommitKernel"),
		allowedFiles: [],
	},
	{
		what: "applyBlueprintChange (the case-schema-coupled canonical writer)",
		matches: (s) => s.includes("db/applyBlueprintChange"),
		allowedFiles: [],
	},
	{
		what: "lib/db/apps (canonical persistence + run lifecycle)",
		matches: (s) => s.includes("db/apps"),
		allowedFiles: [
			// deleteMediaAssetForChatRun — the declared media-write adapter.
			"media/removeMediaAsset.ts",
			// loadAppProjectId — a read helper for the at-source attach verdict.
			"media/shared.ts",
		],
	},
	{
		what: "the event-log writer",
		matches: (s) => s.includes("log/writer"),
		allowedFiles: [],
	},
	{
		what: "the organization row service (external writer)",
		matches: (s) => s.includes("organization/service"),
		allowedFiles: ["organization.ts", "automations.ts"],
	},
	{
		what: "the media deletion service (external writer)",
		matches: (s) => s.includes("db/mediaDeletion"),
		allowedFiles: ["media/removeMediaAsset.ts"],
	},
	{
		what: "the lookup authoring service (external writer)",
		matches: (s) => s.includes("lookup/agentService"),
		allowedFiles: ["getLookupTables.ts", "lookupTables.ts"],
	},
	{
		what: "the lookup row service (external reader)",
		matches: (s) => s.includes("lookup/service"),
		allowedFiles: ["lookupTables.ts"],
	},
	{
		what: "media asset metadata persistence",
		matches: (s) => s.includes("db/mediaAssets"),
		allowedFiles: ["media/listMediaAssets.ts", "media/removeMediaAsset.ts"],
	},
];

describe("shared tool source guards", () => {
	const files = toolSourceFiles();

	it("finds the tool sources", () => {
		expect(files.length).toBeGreaterThan(40);
	});

	for (const rule of RULES) {
		it(`no undeclared tool module imports ${rule.what}`, () => {
			const offenders: string[] = [];
			for (const file of files) {
				const rel = relative(TOOLS_ROOT, file).replaceAll("\\", "/");
				if (rule.allowedFiles.includes(rel)) continue;
				const source = readFileSync(file, "utf8");
				if (importedSpecifiers(source).some(rule.matches)) {
					offenders.push(rel);
				}
			}
			expect(offenders).toEqual([]);
		});
	}

	it("every external-writer exception belongs to a tool that declares the capability", () => {
		/* organization.ts hosts the place-row writers (organization-write);
		 * automations.ts only reads (organization-read); removeMediaAsset owns
		 * media-write. A future exception must extend this map deliberately. */
		const required: Record<string, string> = {
			"organization.ts": "organization-write",
			"automations.ts": "organization-read",
			"media/removeMediaAsset.ts": "media-write",
			"lookupTables.ts": "lookup-write",
			"getLookupTables.ts": "lookup-read",
		};
		const byCapability = new Map<string, string[]>();
		for (const entry of SHARED_TOOL_REGISTRY) {
			for (const capability of entry.policy.capabilities) {
				const names = byCapability.get(capability) ?? [];
				names.push(entry.saName);
				byCapability.set(capability, names);
			}
		}
		for (const [file, capability] of Object.entries(required)) {
			expect(
				byCapability.get(capability),
				`${file} imports an external service but no registry entry declares ${capability}`,
			).toBeTruthy();
		}
	});
});
