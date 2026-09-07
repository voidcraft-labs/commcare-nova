import { build } from "esbuild";
import { expect, test } from "vitest";

test("the full name catalog ships only behind the lazy search boundary", async () => {
	const { metafile } = await build({
		entryPoints: [
			"lib/domain/index.ts",
			"lib/domain/languageRegistry/index.ts",
			"lib/domain/languageRegistry/load.ts",
		],
		outdir: "unused-test-bundle",
		bundle: true,
		write: false,
		metafile: true,
		platform: "browser",
		format: "esm",
		splitting: true,
	});
	function staticInputs(entryPoint: string): string[] {
		const entry = Object.entries(metafile.outputs).find(
			([, output]) => output.entryPoint === entryPoint,
		);
		if (!entry) throw new Error(`Missing bundled entrypoint: ${entryPoint}`);
		const visited = new Set<string>();
		function visit(file: string) {
			if (visited.has(file)) return;
			visited.add(file);
			for (const imported of metafile.outputs[file].imports) {
				if (!imported.external && imported.kind !== "dynamic-import")
					visit(imported.path);
			}
		}
		visit(entry[0]);
		return [...visited].flatMap((file) =>
			Object.keys(metafile.outputs[file].inputs),
		);
	}
	const names = "lib/domain/languageRegistry/names.catalog.ts";
	expect(staticInputs("lib/domain/languageRegistry/search.ts")).toContain(
		names,
	);
	expect(staticInputs("lib/domain/languageRegistry/index.ts")).not.toContain(
		names,
	);
	expect(staticInputs("lib/domain/languageRegistry/load.ts")).not.toContain(
		names,
	);
	expect(
		staticInputs("lib/domain/index.ts").filter((file) =>
			file.startsWith("lib/domain/languageRegistry/"),
		),
	).toEqual([]);
});
