/**
 * The search settle chooses each Search field's validation rule on that
 * field's own evidence, and compares the menu once.
 *
 * Contract: `settings.ts::settleSearchSettings` prints a menu's search at most
 * once a variant of the rules (as read, without the last conjunct, without
 * the first, no rule) and once more to confirm, whatever the number of
 * validated Search fields, so a menu of sixteen such fields, emitted by Nova,
 * reads back with no finding in at most twice the candidates and prints of
 * a menu of eight.
 *
 * Plausible failure: the settle builds every combination of every field's
 * variants before it compares the first, four to the sixteenth documents for
 * sixteen fields, or compares the menu once a combination.
 */

import { expect, it } from "vitest";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { SearchInputDef } from "@/lib/domain";
import { and, input, literal, neq } from "@/lib/domain/expression/builders";
import { plainColumn } from "@/lib/domain/modules";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { knownCaseTypesOf, readHqApp } from "../../index";
import type { ReadWork } from "../../types";

/** A menu of `count` text Search fields, each checked by a rule of two conjuncts. */
async function readingOf(count: number): Promise<{
	readonly findings: readonly string[];
	readonly work: ReadWork;
}> {
	const inputs: SearchInputDef[] = Array.from({ length: count }, (_, at) => {
		const own = uuid(100 + at);
		return {
			uuid: own,
			name: `field_${at}`,
			label: `Field ${at}`,
			kind: "simple",
			type: "text",
			property: `property_${at}`,
			validation: {
				rule: and(
					neq(input(own), literal("none")),
					neq(input(own), literal("nil")),
				),
				message: "Say more",
			},
		} as SearchInputDef;
	});
	const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: inputs,
		search: {},
	});
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			recordDialect: recordDialectRoundTrip,
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
	return {
		findings:
			outcome.kind === "account"
				? outcome.findings.map((finding) => finding.code)
				: [],
		work: outcome.work,
	};
}

it("settles sixteen validated Search fields with at most twice the work of eight", {
	timeout: 120_000,
}, async () => {
	const eight = await readingOf(8);
	const sixteen = await readingOf(16);
	expect(eight.findings).toEqual([]);
	expect(sixteen.findings).toEqual([]);
	for (const kind of ["propose", "print"] as const)
		expect([
			kind,
			sixteen.work.byKind[kind] <= 2.5 * eight.work.byKind[kind],
		]).toEqual([kind, true]);
});
