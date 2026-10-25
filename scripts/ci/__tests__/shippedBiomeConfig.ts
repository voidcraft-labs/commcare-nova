import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Copies the repository's `biome.json` into `directory` together with every
 * GritQL plugin it names, so a linter run there loads the configuration that
 * ships. Biome refuses to lint at all when a named plugin file is missing.
 */
export function copyShippedBiomeConfig(directory: string): void {
	copyFileSync("biome.json", join(directory, "biome.json"));
	const config = JSON.parse(readFileSync("biome.json", "utf8")) as {
		plugins?: (string | { path: string })[];
	};
	for (const plugin of config.plugins ?? []) {
		const path = typeof plugin === "string" ? plugin : plugin.path;
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		copyFileSync(path, join(directory, path));
	}
}
