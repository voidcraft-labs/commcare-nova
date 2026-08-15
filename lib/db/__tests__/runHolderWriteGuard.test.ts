// Structural guard over the run-holder write surface.
//
// Holder safety is an ordering-and-confinement property, so it cannot be proven
// by exercising any one writer: a NEW writer that skips the exact-holder
// predicate is correct in isolation and wrong for the system. This suite reads
// the production sources and pins the shape instead — which files may issue
// `apps` DML at all, that every lifecycle/terminal/reaper write carries an exact
// holder predicate, that reapers are handed a scanned identity rather than a
// bare id, and that operator recovery cannot release a holder tokenlessly.
//
// A failure here is usually not a bug in the named function — it means a write
// path grew outside the reviewed database authorities, and the review that
// should have covered it did not happen.

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

/** Every lifecycle writer that mutates an app while a holder owns it.
 *  `writeCommittedBatch` lives in the canonical commit kernel; the rest stay
 *  with the run lifecycle in `apps.ts`. */
const LIFECYCLE_APP_WRITERS = [
	{ file: "lib/db/canonicalCommitKernel.ts", name: "writeCommittedBatch" },
	{ file: "lib/db/apps.ts", name: "completeAndSettleRunInTransaction" },
	{ file: "lib/db/apps.ts", name: "refreshEditLease" },
	{ file: "lib/db/apps.ts", name: "refreshBuildLiveness" },
	{ file: "lib/db/apps.ts", name: "clearRunLock" },
	{ file: "lib/db/apps.ts", name: "clearRunLockAndSettle" },
	{ file: "lib/db/apps.ts", name: "failApp" },
	{ file: "lib/db/apps.ts", name: "recoverAppStatus" },
	{ file: "lib/db/apps.ts", name: "setAwaitingInput" },
] as const;

/** Credit writers that settle or refund against a specific generation. */
const CREDIT_TERMINAL_WRITERS = [
	"refundReservation",
	"settleAndRelease",
	"refundStaleReservation",
	"refundStaleGeneration",
] as const;

describe("run-holder write structural guard", () => {
	it("keeps all production apps DML inside the reviewed database authorities", () => {
		const appDml =
			/\.(?:insertInto|updateTable|deleteFrom|truncateTable)\(\s*["']apps["']\s*\)/;
		const writers = ["lib", "app", "scripts"]
			.flatMap(productionTypeScriptFiles)
			.filter((path) => appDml.test(source(path)))
			.sort();

		expect(writers).toEqual([
			"lib/db/appGenesis.ts",
			"lib/db/apps.ts",
			"lib/db/canonicalCommitKernel.ts",
			"lib/db/credits.ts",
		]);
		// Operator recovery delegates to `recoverAppStatus` rather than issuing its
		// own DML, so its writes go through the same holder proof as everything else.
		expect(source("scripts/recover-app.ts")).not.toMatch(appDml);
		// The frozen pre-canonical repair owns exactly one catalog-row update and
		// the manifest-pinned orphan-app deletion; its operator script delegates
		// into that transaction authority.
		const frozenRepair = source(
			"lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseRepair.ts",
		);
		expect(frozenRepair.match(/\bUPDATE apps\b/g)?.length).toBe(1);
		expect(frozenRepair.match(/\bDELETE FROM apps\b/g)?.length).toBe(1);
		// It writes NO history, and that is the design rather than an omission:
		// `app_changes` and `app_change_fold_baselines` do not exist yet when the
		// repair runs — the canonical migration creates them, renaming
		// `accepted_mutations` on the way — so there is nothing to append to. The
		// migration's own per-app Project-bearing fold baseline then captures the
		// already-repaired rows, which is what lets the fold still terminate at
		// the exact current state. Appending a mutation batch here would put a
		// change in the durable log that no author made.
		// Both the Kysely builder and raw SQL, because `\binsert\b` matches
		// neither `insertInto(` (the house form — `\b` fails before the capital I)
		// nor `INSERT INTO` reliably, while it DOES match the word "insert" in a
		// comment. A fence that misses the idiomatic violation and fires on prose
		// is the shape this suite exists to catch.
		expect(frozenRepair).not.toMatch(/\.insertInto\s*\(/);
		expect(frozenRepair).not.toMatch(/\bINSERT\s+INTO\b/i);
		expect(
			source("scripts/repair-canonical-identity-foundation.ts"),
		).not.toMatch(appDml);
		expect(
			source("lib/db/apps.ts").match(new RegExp(appDml, "g"))?.length,
		).toBe(16);
		// The genesis owner holds exactly one apps DML site — the sequence-1
		// insert inside `writePreparedGenesisInTransaction` (pinned above).
		expect(
			source("lib/db/appGenesis.ts").match(new RegExp(appDml, "g"))?.length,
		).toBe(1);
		// The canonical commit kernel owns exactly one apps DML site — the
		// committed-batch write tail — and its holder fence is pinned by the
		// lifecycle-writer sweep below (`writeCommittedBatch`).
		expect(
			source("lib/db/canonicalCommitKernel.ts").match(new RegExp(appDml, "g"))
				?.length,
		).toBe(1);
		// The sixteenth apps.ts site is `writeProjectMoveChange`. A bare count would let
		// a future writer drop its fence and still pass, so pin the fence itself:
		// the Project move is a compare-and-set on BOTH the source Project and the
		// prior head, and it throws rather than reporting success when either has
		// moved underneath.
		const projectMove = exportedFunction(
			"lib/db/apps.ts",
			"writeProjectMoveChange",
		);
		expect(projectMove).toContain(
			'.where("project_id", "=", args.fromProjectId)',
		);
		expect(projectMove).toContain('.where("mutation_seq", "=", args.seq - 1)');
		expect(projectMove).toContain("app source/head changed");
		expect(
			source("lib/db/credits.ts").match(new RegExp(appDml, "g"))?.length,
		).toBe(5);
	});

	it("mints or proves a holder at every creation and claim transaction", () => {
		// A `generating` creation is born holding its app, so explicit-blank
		// genesis may only open a generating row through the holder it also
		// writes (the nonce mints exactly when the status arms the lease).
		const blankGenesis = exportedFunction(
			"lib/db/appGenesis.ts",
			"createExplicitBlankApp",
		);
		expect(blankGenesis).toContain('status === "generating"');
		expect(
			exportedFunction(
				"lib/db/appGenesis.ts",
				"writePreparedGenesisInTransaction",
			),
		).toContain('.insertInto("apps")');

		// A claim books its reservation inside the same transaction that takes the
		// row, so the reservation marker can never name a generation that never ran.
		expect(exportedFunction("lib/db/apps.ts", "claimAndReserveRun")).toContain(
			"debitAndBookReservation(tx",
		);
		expect(exportedFunction("lib/db/apps.ts", "claimAndReserveRun")).toContain(
			"run_id: runId",
		);

		// Re-reserving an app that already has a holder must prove that holder
		// first; otherwise a second build would silently inherit the reservation.
		const reserve = exportedFunction("lib/db/apps.ts", "reserveForNewBuild");
		expect(reserve).toContain("debitAndBookReservation(tx");
		expect(reserve).toContain("exactRunHolderMatches");

		const completion = exportedFunction(
			"lib/db/apps.ts",
			"completeAndSettleRun",
		);
		expect(completion).toContain("lockActorGenerationGateForAppHolder");
		expect(completion).toContain("completeAndSettleRunInTransaction");
	});

	it("requires exact SQL holder predicates on lifecycle and recovery app writes", () => {
		for (const { file, name } of LIFECYCLE_APP_WRITERS) {
			expect(exportedFunction(file, name), `${file}::${name}`).toContain(
				"expectedRunHolderPredicate",
			);
		}
		expect(exportedFunction("lib/db/apps.ts", "reacquireLease")).toContain(
			"expectedPausedRunResumePredicate",
		);
		// The one sanctioned absent-holder exception: a falsely reaped build
		// repairing its own error row.
		expect(
			exportedFunction("lib/db/apps.ts", "completeAndSettleRunInTransaction"),
		).toContain("expectedReapedBuildCompletionPredicate");
		// Operator recovery asserts the app is FREE, never that a holder matches.
		expect(exportedFunction("lib/db/apps.ts", "recoverAppStatus")).toContain(
			"noRunHolderPredicate",
		);
	});

	it("requires exact SQL holder predicates on credit terminal and reaper writes", () => {
		for (const name of CREDIT_TERMINAL_WRITERS) {
			const body = exportedFunction("lib/db/credits.ts", name);
			expect(body, `lib/db/credits.ts::${name}`).toContain(
				"expectedRunHolderPredicate",
			);
			// A zero-row compare-and-set here would silently double-refund.
			expect(body, `lib/db/credits.ts::${name}`).toContain(
				"requireExactHolderWrite",
			);
		}
		// Settlement keys on the exact holder, never on the absence of a lease —
		// a "no holder" branch would settle whatever generation happened to be there.
		expect(
			exportedFunction("lib/db/credits.ts", "settleAndRelease"),
		).not.toContain('lease.mode === "none"');
	});

	it("carries scanned identities through every reaper queue and exposes no bare-id reaper API", () => {
		for (const name of ["reapStaleGenerating", "reapStaleReservation"]) {
			const body = exportedFunction("lib/db/apps.ts", name);
			expect(body, name).toContain("expectedIdentity: ExactRunHolderIdentity");
			// Optional would let a caller reap by app id alone.
			expect(body, name).not.toContain("expectedIdentity?:");
		}
		for (const name of ["refundStaleGeneration", "refundStaleReservation"]) {
			expect(exportedFunction("lib/db/credits.ts", name), name).toContain(
				"expectedHolder: ExactRunHolderIdentity",
			);
		}

		const apps = source("lib/db/apps.ts");
		const bareReaperCall =
			/\breapStale(?:Generating|Reservation)\(\s*[^,()\n]+\s*\)/g;
		expect(apps.match(bareReaperCall) ?? []).toEqual([]);
		// The scan's own row is what narrows to a token — never a reconstructed one.
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

	it("proves the target holder before installing a thread marker", () => {
		const body = exportedFunction("lib/db/threads.ts", "upsertThreadTurn");
		// Fixed lock order: the authority row (app or design session, locked
		// inside `lockThreadTargetAuthority`), then the thread row. Taking
		// them the other way round would deadlock against a writer that
		// already holds the thread.
		const authorityLock = body.indexOf("lockThreadTargetAuthority(");
		const threadLock = body.indexOf('.selectFrom("threads")');
		expect(authorityLock).toBeGreaterThanOrEqual(0);
		expect(authorityLock).toBeLessThan(threadLock);
		// The holder proof rides the locked authority's lease
		// (`threadTargetHolderMatches` → `exactRunHolderMatches`).
		expect(body).toContain("threadTargetHolderMatches");
		expect(body).toContain("throw new RunHolderLostError");
		// Holder loss outranks a thread/target mismatch: a lost holder must
		// not be reported as someone else's thread.
		expect(body.indexOf("if (holderLost !== null)")).toBeLessThan(
			body.indexOf("if (existing && !existingMatchesTarget)"),
		);

		// A lost holder still persists the transcript — the user's words are not
		// the run's to discard — but installs no stream or holder marker.
		const lostBranch = body.slice(
			body.indexOf("if (holderLost !== null)"),
			body.indexOf('insertInto("threads")'),
		);
		expect(lostBranch).toContain("messages: JSON.stringify(merged)");
		expect(lostBranch).not.toContain("active_stream_id");
		expect(lostBranch).not.toContain("active_holder_nonce");
	});

	it("terminates a holder-lost chat run before it can publish a nonce", () => {
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
		// Publishing a nonce the run no longer owns would hand the client a
		// capability that every later compare-and-set rejects.
		expect(route.slice(terminate, publishNonce)).toContain("return;");
		expect(terminate).toBeLessThan(publishNonce);
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
