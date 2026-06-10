import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Convention pin: no module under `lib/doc/mutations/` or
 * `lib/doc/hooks/`, and none of the client-bundled package-root
 * modules (the commit gate's verdict + phase plumbing run on every UI
 * dispatch), may import `@/lib/logger`.
 *
 * These surfaces bundle CLIENT-side — the reducers run inside the
 * browser doc store (and must stay byte-identical with their server
 * and replay runs), and the hooks are client components' mutation
 * surface. The structured logger's production path writes to
 * `process.stdout`, which Next's browser `process` shim doesn't
 * define — so a degraded-path warn would THROW in the production
 * client, on exactly the warn-and-skip paths that exist to keep the
 * app alive. Degraded-path reporting in these packages uses
 * `console.warn` / `console.debug` instead.
 *
 * This is a source-text scan rather than a behavioral assertion
 * because `vitest.setup.ts` mocks `@/lib/logger` globally — a runtime
 * test can never observe the real logger's client crash, which is how
 * the original regression shipped unnoticed. The walk is recursive so
 * nested subpackages stay covered (`__tests__` excluded — test files
 * may assert on the mocked logger), and the scan asserts it visited
 * at least one file so a path bug can't pass as a vacuously empty
 * walk.
 */
describe("lib/doc client-bundled packages avoid the structured logger", () => {
	const packageDirs = ["../mutations", "../hooks"] as const;
	/* Package-root modules on the browser's gated-dispatch path. Named
	 * individually (not a root walk) because some root modules are
	 * legitimately server-reachable-only; these run inside every builder
	 * edit. */
	const clientRootModules = [
		"../commitVerdicts.ts",
		"../commitPhaseContext.tsx",
		"../identifierVerdicts.ts",
		"../connectConfig.ts",
	] as const;

	it("no file imports @/lib/logger", () => {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const offenders: string[] = [];
		let visited = 0;
		for (const file of clientRootModules) {
			const filePath = fileURLToPath(new URL(file, import.meta.url));
			visited += 1;
			const source = readFileSync(filePath, "utf8");
			if (source.includes("@/lib/logger")) {
				offenders.push(join("lib/doc", relative(packageRoot, filePath)));
			}
		}
		for (const dir of packageDirs) {
			const dirPath = fileURLToPath(new URL(dir, import.meta.url));
			const entries = readdirSync(dirPath, {
				withFileTypes: true,
				recursive: true,
			});
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				// `parentPath` is the directory holding the entry — for nested
				// entries that is a SUBdirectory of `dirPath`, so the path must
				// build from it, not from the walk root.
				const filePath = join(entry.parentPath, entry.name);
				if (relative(dirPath, filePath).includes("__tests__")) continue;
				visited += 1;
				const source = readFileSync(filePath, "utf8");
				if (source.includes("@/lib/logger")) {
					offenders.push(join("lib/doc", relative(packageRoot, filePath)));
				}
			}
		}
		expect(visited).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});
});
