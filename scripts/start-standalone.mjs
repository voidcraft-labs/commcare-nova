#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { launchStandaloneServer } from "./lib/standaloneLauncher.mts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

try {
	process.exitCode = await launchStandaloneServer(repositoryRoot);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[start-standalone] ${message}`);
	process.exitCode = 1;
}
