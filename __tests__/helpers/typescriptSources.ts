import { readdirSync, readFileSync } from "node:fs";
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

/** A filesystem inventory is deliberate: tsconfig globs omit dot-directories. */
export function readTypeScriptSources(
	roots: readonly string[],
	includeTests = false,
): Record<string, string> {
	const sources: Record<string, string> = {};
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const name = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (includeTests || entry.name !== "__tests__") visit(name);
			} else if (
				entry.isFile() &&
				/\.[cm]?[jt]sx?$/.test(entry.name) &&
				(includeTests || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
			) {
				sources[name.split(path.sep).join("/")] = readFileSync(name, "utf8");
			}
		}
	};
	for (const root of roots) visit(root);
	return sources;
}
