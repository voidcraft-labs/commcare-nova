import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function productionTypeScriptFiles(dir: string): string[] {
	return readdirSync(join(process.cwd(), dir), {
		recursive: true,
		encoding: "utf8",
	})
		.filter(
			(path) =>
				(path.endsWith(".ts") || path.endsWith(".tsx")) &&
				!path.includes("__tests__") &&
				!path.endsWith(".test.ts") &&
				!path.endsWith(".test.tsx") &&
				!path.includes("migrations/"),
		)
		.map((path) => `${dir}/${path}`);
}

function source(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function exportedFunction(relativePath: string, name: string): string {
	const contents = source(relativePath);
	const exportedStart = contents.indexOf(`export async function ${name}(`);
	const privateStart = contents.indexOf(`async function ${name}(`);
	const start = exportedStart >= 0 ? exportedStart : privateStart;
	if (start < 0) throw new Error(`${name} not found in ${relativePath}`);
	const next = contents.indexOf("\nexport ", start + 1);
	return contents.slice(start, next < 0 ? contents.length : next);
}

describe("run-holder write structural guard", () => {
	it("keeps all production apps DML inside the two reviewed database authorities", () => {
		const appDml =
			/\.(?:insertInto|updateTable|deleteFrom|truncateTable)\(\s*["']apps["']\s*\)/;
		const writers = ["lib", "app", "scripts"]
			.flatMap(productionTypeScriptFiles)
			.filter((path) => appDml.test(source(path)))
			.sort();

		expect(writers).toEqual(["lib/db/apps.ts", "lib/db/credits.ts"]);
		expect(source("scripts/recover-app.ts")).not.toMatch(appDml);
		expect(
			source("lib/db/apps.ts").match(new RegExp(appDml, "g"))?.length,
		).toBe(17);
		expect(
			source("lib/db/credits.ts").match(new RegExp(appDml, "g"))?.length,
		).toBe(5);
	});

	it("declares the manifest runtime at every holder creation, replacement, or reacquire transaction", () => {
		for (const [name, holderWrite] of [
			["createApp", '.insertInto("apps")'],
			["claimAndReserveRun", "debitAndBookReservation(tx"],
			["reserveForNewBuild", "debitAndBookReservation(tx"],
			["reacquireLease", '.updateTable("apps")'],
		] as const) {
			const body = exportedFunction("lib/db/apps.ts", name);
			const declaration = body.indexOf("declareRuntimeReader(tx)");
			expect(declaration).toBeGreaterThanOrEqual(0);
			expect(declaration).toBeLessThan(body.indexOf(holderWrite));
		}
		expect(exportedFunction("lib/db/apps.ts", "createApp")).toContain(
			'(opts?.status ?? "generating") === "generating"',
		);
		expect(exportedFunction("lib/db/apps.ts", "reserveForNewBuild")).toContain(
			"exactRunHolderMatches",
		);
		expect(exportedFunction("lib/db/apps.ts", "claimAndReserveRun")).toContain(
			"run_id: runId",
		);
	});

	it("declares v1 before every same-holder, heartbeat, and terminal app write", () => {
		for (const [path, names] of [
			[
				"lib/db/apps.ts",
				[
					"writeCommittedBatch",
					"completeAndSettleRun",
					"refreshEditLease",
					"refreshBuildLiveness",
					"clearRunLock",
					"clearRunLockAndSettle",
					"failApp",
					"recoverAppStatus",
					"setAwaitingInput",
				],
			],
			[
				"lib/db/credits.ts",
				[
					"debitAndBookReservation",
					"refundReservation",
					"settleAndRelease",
					"refundStaleReservation",
					"refundStaleGeneration",
				],
			],
		] as const) {
			for (const name of names) {
				const body = exportedFunction(path, name);
				const declaration = body.indexOf("declareRuntimeReader(tx)");
				expect(declaration, `${path}::${name}`).toBeGreaterThanOrEqual(0);
				expect(declaration, `${path}::${name}`).toBeLessThan(
					body.indexOf('.updateTable("apps")'),
				);
			}
		}
	});

	it("proves the app holder before installing a thread marker", () => {
		const body = exportedFunction("lib/db/threads.ts", "upsertThreadTurn");
		const appLock = body.indexOf('.selectFrom("apps")');
		const compatibilityLock = body.indexOf(
			"readRunHolderNonceEnforcementForShare(tx)",
		);
		const threadLock = body.indexOf('.selectFrom("threads")');
		expect(appLock).toBeGreaterThanOrEqual(0);
		expect(appLock).toBeLessThan(compatibilityLock);
		expect(compatibilityLock).toBeLessThan(threadLock);
		expect(body).toContain("exactRunHolderMatches");
		expect(body).toContain("throw new RunHolderLostError");
		expect(body.indexOf("if (holderLost !== null)")).toBeLessThan(
			body.indexOf("existing.app_id !== args.appId"),
		);

		const lostBranch = body.slice(
			body.indexOf("if (holderLost !== null)"),
			body.indexOf('insertInto("threads")'),
		);
		expect(lostBranch).toContain("messages: JSON.stringify(merged)");
		expect(lostBranch).not.toContain("active_stream_id");
		expect(lostBranch).not.toContain("active_holder_nonce");

		const route = source("app/api/chat/route.ts");
		const persist = route.indexOf("threadPersisted = await upsertThreadTurn");
		const terminate = route.indexOf(
			'await failRun(err, "route:thread-marker-holder-lost")',
			persist,
		);
		const publishNonce = route.indexOf(
			"writer.writePrivateHolderNonce(holderNonce)",
			persist,
		);
		expect(terminate).toBeGreaterThan(persist);
		expect(route.slice(terminate, publishNonce)).toContain("return;");
		expect(terminate).toBeLessThan(publishNonce);
	});

	it("requires exact SQL holder predicates on lifecycle and recovery app writes", () => {
		for (const name of [
			"writeCommittedBatch",
			"completeAndSettleRun",
			"refreshEditLease",
			"refreshBuildLiveness",
			"clearRunLock",
			"clearRunLockAndSettle",
			"failApp",
			"recoverAppStatus",
			"setAwaitingInput",
		]) {
			expect(exportedFunction("lib/db/apps.ts", name)).toContain(
				"expectedRunHolderPredicate",
			);
		}
		expect(exportedFunction("lib/db/apps.ts", "reacquireLease")).toContain(
			"expectedPausedRunResumePredicate",
		);
		expect(
			exportedFunction("lib/db/apps.ts", "completeAndSettleRun"),
		).toContain("expectedReapedBuildCompletionPredicate");
		expect(exportedFunction("lib/db/apps.ts", "recoverAppStatus")).toContain(
			"noRunHolderPredicate",
		);
	});

	it("requires exact SQL holder predicates on credit terminal and reaper writes", () => {
		for (const name of [
			"refundReservation",
			"settleAndRelease",
			"refundStaleReservation",
			"refundStaleGeneration",
		]) {
			const body = exportedFunction("lib/db/credits.ts", name);
			expect(body).toContain("expectedRunHolderPredicate");
			expect(body).toContain("requireExactHolderWrite");
		}
		expect(
			exportedFunction("lib/db/credits.ts", "settleAndRelease"),
		).not.toContain('lease.mode === "none"');
	});

	it("carries scanned identities through every reaper queue and exposes no bare-id reaper API", () => {
		for (const name of ["reapStaleGenerating", "reapStaleReservation"]) {
			const body = exportedFunction("lib/db/apps.ts", name);
			expect(body).toContain("expectedIdentity: ExactRunHolderIdentity");
			expect(body).not.toContain("expectedIdentity?:");
		}
		for (const name of ["refundStaleGeneration", "refundStaleReservation"]) {
			expect(exportedFunction("lib/db/credits.ts", name)).toContain(
				"expectedHolder: ExactRunHolderIdentity",
			);
		}

		const apps = source("lib/db/apps.ts");
		const bareReaperCall =
			/\breapStale(?:Generating|Reservation)\(\s*[^,()\n]+\s*\)/g;
		expect(apps.match(bareReaperCall) ?? []).toEqual([]);
		expect(apps).toContain("toExactRunHolderIdentity(lease.holderIdentity)");
	});

	it("keeps reservation booking restricted to its two locked callers", () => {
		const files = ["lib", "app", "scripts"].flatMap(productionTypeScriptFiles);
		const callers = files
			.flatMap((path) => {
				const matches =
					source(path).match(/\bdebitAndBookReservation\(/g) ?? [];
				return matches.map(() => path);
			})
			.sort();
		// One occurrence is the helper declaration; the two others are its only
		// app-row-locked callsites.
		expect(callers).toEqual([
			"lib/db/apps.ts",
			"lib/db/apps.ts",
			"lib/db/credits.ts",
		]);
	});

	it("requires paired explicit operator token flags before recover-app delegates", () => {
		const recover = source("scripts/recover-app.ts");
		expect(recover).toContain('"--holder-mode <mode>"');
		expect(recover).toContain('"--holder-run-id <runId>"');
		expect(recover).toContain('"--holder-nonce <uuid>"');
		expect(recover).toContain("recoverAppStatus(appId, expectedHolder)");
		expect(recover).toContain("exactRunHolderMatches");
	});
});
