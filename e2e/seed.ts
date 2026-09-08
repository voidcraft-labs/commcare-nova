/** Discover first; allocate only the selected scenarios in the local database. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { seedMultiplayerFixture } from "./lib/multiplayerSeed";
import {
	discoveredScenarioAttempts,
	discoveredSmokeScenarios,
	readDiscoveryReport,
	selectedDiscoveryProjects,
} from "./lib/scenarioSeeds";
import type { SmokeScenario } from "./lib/smokeProfiles";
import {
	createSmokeBuilders,
	smokeSeedEnvironment,
} from "./lib/smokeSeedFactory";

async function main() {
	const secret = process.env.BETTER_AUTH_SECRET;
	const discovery = process.env.NOVA_E2E_DISCOVERY_MANIFEST;
	if (!secret || !discovery)
		throw new Error(
			"Smoke seed requires its secret and native discovery manifest. Run the owning harness.",
		);
	const report = readDiscoveryReport(discovery);
	const requests = discoveredSmokeScenarios(report);
	const selectedProjects = selectedDiscoveryProjects(report);
	const environment = await smokeSeedEnvironment(
		secret,
		process.env.SMOKE_BASE_URL ?? "http://localhost:3000",
	);
	const authDir = path.resolve("e2e/.auth");
	await mkdir(authDir, { recursive: true });
	const scenarios: Record<string, SmokeScenario> = {};
	for (const { key, profile } of requests) {
		const { common, builders } = await createSmokeBuilders(environment);
		const data = await builders[profile]();
		// The selected builder and discriminant use the same validated profile key.
		scenarios[key] = { common, profile, data } as SmokeScenario;
	}
	await writeFile(
		path.join(authDir, "scenarios.json"),
		JSON.stringify(scenarios),
	);
	const mpKeys = discoveredScenarioAttempts("multiplayer");
	const multiplayerScenarios: Record<
		string,
		Awaited<ReturnType<typeof seedMultiplayerFixture>>
	> = {};
	for (const key of mpKeys) {
		multiplayerScenarios[key] = await seedMultiplayerFixture({
			...environment,
			authDir,
			writeFile,
			pathJoin: path.join,
			scenarioKey: key,
		});
	}
	const manualMp = selectedProjects.has("mp-manual");
	const multiplayer = manualMp
		? await seedMultiplayerFixture({
				...environment,
				authDir,
				writeFile,
				pathJoin: path.join,
			})
		: undefined;
	await writeFile(
		path.join(authDir, "multiplayer.json"),
		JSON.stringify({ ...multiplayer, scenarios: multiplayerScenarios }),
	);
	// Development-only consumers retain their file contract, backed by the same factories.
	// They are opt-in and never cause unrelated smoke data to be allocated.
	const profileKeys = discoveredScenarioAttempts("react-profile");
	const profileRun = selectedProjects.has("react-profile");
	const manualCases = selectedProjects.has("case-workspace-manual");
	if (profileRun || manualCases) {
		const { common, builders } = await createSmokeBuilders(environment);
		const reactProfileScenarios: Record<string, unknown> = {};
		for (const key of profileKeys)
			reactProfileScenarios[key] = (
				await builders["react-profile"]()
			).reactProfile;
		const data = {
			...common,
			...(profileRun ? await builders.open() : await builders.workspace()),
			reactProfileScenarios,
		};
		await writeFile(
			path.join(authDir, "state.json"),
			JSON.stringify(common.storageState),
		);
		await writeFile(path.join(authDir, "seed.json"), JSON.stringify(data));
	}
	console.log(
		`[seed] ${requests.length} authenticated and ${mpKeys.length} multiplayer scenario attempts`,
	);
}
main()
	.finally(closeCaseStoreDatabase)
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
