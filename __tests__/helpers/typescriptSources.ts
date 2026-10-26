import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API, type Snapshot } from "typescript/unstable/sync";

/** Parse only the supplied sources. No type checking, imports, watcher, or
 * dependence on generated Next files; the compiler process is always closed. */
export function withTypeScriptSources<T>(
	sources: Readonly<Record<string, string>>,
	inspect: (parsed: ReadonlyMap<string, SourceFile>) => T,
): T {
	const root = process.cwd();
	const config = path.join(root, ".syntax-policy/tsconfig.json");
	const files = Object.fromEntries(
		Object.entries(sources).map(([name, text]) => [
			path.resolve(root, name),
			text,
		]),
	);
	const api = new API({
		cwd: root,
		fs: createVirtualFileSystem({
			...files,
			[config]: JSON.stringify({
				compilerOptions: {
					noResolve: true,
					noLib: true,
					noEmit: true,
					allowJs: true,
					jsx: "preserve",
					target: "esnext",
					module: "esnext",
				},
				files: Object.keys(files),
			}),
		}),
	});
	let snapshot: Snapshot | undefined;
	try {
		snapshot = api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project)
			throw new Error("Could not open the source-policy compiler project");
		const parsed = new Map<string, SourceFile>();
		for (const name of Object.keys(sources)) {
			const absolute = path.resolve(root, name);
			const source = project.program.getSourceFile(absolute);
			if (!source) throw new Error(`Could not parse ${name}`);
			const diagnostics = project.program.getSyntacticDiagnostics(absolute);
			if (diagnostics.length)
				throw new Error(
					`Invalid syntax in ${name}: ${JSON.stringify(diagnostics)}`,
				);
			parsed.set(name, source);
		}
		return inspect(parsed);
	} finally {
		snapshot?.dispose();
		api.close();
	}
}

export function visitTypeScript(
	node: Node,
	inspect: (node: Node) => void,
): void {
	inspect(node);
	node.forEachChild((child) => visitTypeScript(child, inspect));
}

/**
 * The repository's TypeScript and JavaScript sources under `roots`, keyed by
 * their repository path: every file git tracks or would track (`git ls-files
 * --cached --others --exclude-standard`), so a new file counts before it is
 * staged and nothing `.gitignore` names does (Playwright's reports, build
 * output, caches). The inventory is git's, not a tsconfig's, because tsconfig
 * globs omit dot-directories. A tracked file deleted from the working tree is
 * no source.
 */
export function readTypeScriptSources(
	roots: readonly string[],
	includeTests = false,
): Record<string, string> {
	const listed = execFileSync(
		"git",
		[
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			...roots,
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	const sources: Record<string, string> = {};
	for (const file of new Set(listed.split("\0"))) {
		if (
			!/\.[cm]?[jt]sx?$/.test(file) ||
			(!includeTests &&
				(file.split("/").includes("__tests__") ||
					/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)))
		)
			continue;
		try {
			sources[file] = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return sources;
}
