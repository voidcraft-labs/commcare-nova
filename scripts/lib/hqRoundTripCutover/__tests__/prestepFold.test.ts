/**
 * The frozen pre-step fold: the one place a pre-step function is handed
 * pre-step rows. The digest test holds the committed bytes at every head of
 * the stack, and the histories hold what the fold replays. The tree no
 * longer holds the pre-step reducer, so no fresh build of it is compared:
 * the bytes are the ones built where it still was.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";
import { rawDocumentDigest, readRawDocument } from "../oldShape";
import {
	foldCanonicalAppChangeSuffixBounded as frozenFold,
	type PrestepFoldSuffixRow,
} from "../prestep/prestepFold.generated.mjs";
import { rawDocumentFromSnapshot } from "../publishedDocument";
import { HISTORIES } from "./fixtures/fixtureDocuments";
import { readFixtureHistory, readHistoryCarriers } from "./fixtures/preStep";

const PRESTEP_FOLD_SHA256 =
	"7d3525330e07f4f43dd8faec912001f037783caf1ab3982f347d3776c956d415";
const PRESTEP_DIRECTORY = join(import.meta.dirname, "..", "prestep");

function suffixOf(
	rows: ReturnType<typeof readFixtureHistory>["rows"],
): PrestepFoldSuffixRow[] {
	return rows.map((row) => ({
		seq: row.seq,
		batch_id: row.batchId,
		run_id: null,
		actor_id: "fixture-user",
		kind: "autosave",
		mutationsText: row.mutationsText,
		from_project_id: null,
		to_project_id: null,
	}));
}

describe("the frozen pre-step fold", () => {
	it("keeps its committed bytes, importing node:crypto alone", async () => {
		const source = readFileSync(
			join(PRESTEP_DIRECTORY, "prestepFold.generated.mjs"),
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(
			PRESTEP_FOLD_SHA256,
		);
		await init;
		const [imports] = parse(source.toString("utf8"));
		expect(
			imports.flatMap((entry) => (entry.n === undefined ? [] : [entry.n])),
		).toEqual(["node:crypto"]);
	});

	describe.each(HISTORIES.map((history) => [history.document, history.name]))(
		"over %s's history %s",
		(document, name) => {
			const history = readFixtureHistory(document, name);
			const suffix = suffixOf(history.rows);
			const fold = (targetSeq: number) =>
				frozenFold({
					baselineSnapshotText: history.baseline.snapshotText,
					baselineSeq: history.baseline.seq,
					baselineProjectId: "fixture-project",
					targetSeq,
					suffix: suffix.filter((row) => Number(row.seq) <= targetSeq),
				});

			it("reaches the retained document after every row", () => {
				for (const row of history.rows) {
					const frozen = fold(row.seq);
					expect(
						rawDocumentDigest(rawDocumentFromSnapshot(frozen.snapshot)),
					).toBe(
						rawDocumentDigest(
							readRawDocument(
								document,
								readHistoryCarriers(document, name, row.seq),
							),
						),
					);
				}
			});
		},
	);

	describe("refuses what it cannot replay", () => {
		const history = readFixtureHistory("navigation-base", "form-renamed");
		const [row] = suffixOf(history.rows);
		if (row === undefined) throw new Error("The history holds no row.");
		const input = (suffix: PrestepFoldSuffixRow[], targetSeq = 2) => ({
			baselineSnapshotText: history.baseline.snapshotText,
			baselineSeq: 1,
			baselineProjectId: "fixture-project",
			targetSeq,
			suffix,
		});

		it("a gap in the sequence", () => {
			expect(() => frozenFold(input([{ ...row, seq: 3 }], 3))).toThrow(
				/not contiguous/,
			);
		});

		it("a fold baseline inside the rows", () => {
			expect(() =>
				frozenFold(
					input([
						{
							...row,
							kind: "fold-baseline",
							batch_id: "fold-baseline:hq-round-trip-emission",
							actor_id: "system:hq-round-trip-emission",
							mutationsText: "[]",
						},
					]),
				),
			).toThrow();
		});

		it("a row of an unknown kind", () => {
			expect(() => frozenFold(input([{ ...row, kind: "invented" }]))).toThrow();
		});

		it("a mutation the pre-step dialect does not hold", () => {
			expect(() =>
				frozenFold(
					input([
						{
							...row,
							mutationsText: JSON.stringify([
								{
									kind: "setAppSettings",
									settings: { showSavedForms: true, showIncompleteForms: true },
								},
							]),
						},
					]),
				),
			).toThrow();
		});

		it("a target the rows do not reach", () => {
			expect(() => frozenFold(input([row], 3))).toThrow(/does not reach/);
		});
	});
});
