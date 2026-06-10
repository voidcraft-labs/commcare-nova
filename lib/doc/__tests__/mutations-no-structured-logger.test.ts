import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Convention pin: no module under `lib/doc/mutations/` or
 * `lib/doc/hooks/` may import `@/lib/logger`.
 *
 * Both packages bundle CLIENT-side — the reducers run inside the
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
 * the original regression shipped unnoticed.
 */
describe("lib/doc client-bundled packages avoid the structured logger", () => {
	const packageDirs = ["../mutations", "../hooks"] as const;

	it("no file imports @/lib/logger", () => {
		const offenders: string[] = [];
		for (const dir of packageDirs) {
			const dirPath = fileURLToPath(new URL(dir, import.meta.url));
			for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
				if (!entry.isFile()) continue;
				const source = readFileSync(`${dirPath}/${entry.name}`, "utf8");
				if (source.includes("@/lib/logger")) {
					offenders.push(`${dir.replace("../", "lib/doc/")}/${entry.name}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
