/**
 * Pre-`dev` Node-version guard.
 *
 * Refuses to boot the dev server on a Node version other than the one pinned in
 * `.nvmrc` — the single source of truth CI (`node-version-file`) and the Docker
 * image (the `quality` job's guard) also use. A local/prod patch divergence is
 * the #143 class, so `npm run dev` enforces the match.
 *
 * This ENFORCES the version; it can't auto-switch (an npm script runs on the
 * Node that invoked it). For zero-thought switching, enable your version
 * manager's cd hook — both read `.nvmrc`:
 *   nvm:  the "deeper shell integration" snippet (runs `nvm use` on cd)
 *   fnm:  eval "$(fnm env --use-on-cd)"
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
const have = process.versions.node;

if (have !== want) {
	console.error(
		[
			"",
			"  ✗ Wrong Node version for this repo.",
			`      .nvmrc pins ${want}; you're on ${have}.`,
			"",
			"    Switch with your version manager (both read .nvmrc):",
			"      nvm:  nvm install && nvm use",
			"      fnm:  fnm use --install-if-missing",
			"",
		].join("\n"),
	);
	process.exit(1);
}
