/**
 * A run that throws still leaves evidence (part 09 §3, "The report"): every
 * line is handed to the script's sink as it is made, and the report ends in
 * an `outcome` line, `stopped` by `error` with a content-free class. The
 * plausible failures are a throw that leaves the evidence with no outcome at
 * all, and a database error whose text, which can quote a stored row, reaches
 * the report or the terminal.
 */

import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { AppDatabase } from "@/lib/db/pg";
import type { ReportLine } from "../report";
import { errorClassOf, errorTextOf, runMigrate, runScan } from "../run";
import { CutoverPostconditionError } from "../writer";

const STORED_TEXT = "Failing row contains (Clinic of Saint Agnes)";

/** A database whose every statement fails as Postgres reports a check violation. */
function failingDatabase(): Kysely<AppDatabase> {
	class FailingDriver extends DummyDriver {
		override async acquireConnection() {
			return {
				executeQuery: async () => {
					throw Object.assign(new Error(STORED_TEXT), {
						code: "23514",
						detail: STORED_TEXT,
					});
				},
				streamQuery: async function* () {
					yield* [];
					throw new Error(STORED_TEXT);
				},
			};
		}
	}
	return new Kysely<AppDatabase>({
		dialect: {
			createAdapter: () => new PostgresAdapter(),
			createDriver: () => new FailingDriver(),
			createIntrospector: (db) => new PostgresIntrospector(db),
			createQueryCompiler: () => new PostgresQueryCompiler(),
		},
	});
}

describe("a run that throws", () => {
	it.each(["dry-run", "execute"] as const)(
		"ends the %s report with a stopped outcome naming the error's class alone",
		async (mode) => {
			const db = failingDatabase();
			const printed: ReportLine[] = [];
			try {
				const run = runMigrate(db, {
					mode,
					expectPlanDigest: "a".repeat(64),
					onLine: (line) => printed.push(line),
				});
				const error = await run.then(
					() => undefined,
					(thrown: unknown) => thrown,
				);
				expect(error).toBeInstanceOf(Error);
				expect(printed.at(-1)).toEqual({
					report: "hq-round-trip-expressions",
					mode,
					section: "outcome",
					outcome: "stopped",
					stoppedBy: ["error"],
					errorClass: "database-23514",
				});
				expect(JSON.stringify(printed)).not.toContain("Saint Agnes");
				expect(errorTextOf(error)).not.toContain("Saint Agnes");
			} finally {
				await db.destroy();
			}
		},
	);

	it("ends the scan's report the same way", async () => {
		const db = failingDatabase();
		const printed: ReportLine[] = [];
		try {
			await expect(
				runScan(db, { onLine: (line) => printed.push(line) }),
			).rejects.toThrow();
			expect(printed.map((line) => [line.section, line.errorClass])).toEqual([
				["outcome", "database-23514"],
			]);
		} finally {
			await db.destroy();
		}
	});

	it("prints this cutover's own message, which names ids and counts only", () => {
		const error = new CutoverPostconditionError("app app-1 no longer loads");
		expect(errorClassOf(error)).toBe("postcondition");
		expect(errorTextOf(error)).toBe(
			"The cutover stopped (postcondition): app app-1 no longer loads",
		);
		expect(errorClassOf(new TypeError("x"))).toBe("internal");
	});
});
