/**
 * The canonical form is complete over Nova's own documents: a read back of a
 * fuzz document's export gives the document's canonical form, exactly.
 *
 * Contract: for each document of the compiler's fuzz corpora (the field-tree
 * corpus, the workflow corpus, the record-expression corpus, every record
 * slot a menu, a list, a search, a form's entry or a form's case change
 * evaluates holding a tree drawn from the whole record rule set, and the
 * temporal-branch corpus, the workflow
 * corpus with a value-giving branch that gives a date or a date and time, from
 * a case property or from literals alone, in the record slots that read the
 * menu's case, and the typed-literal corpus, the workflow corpus with a typed
 * date or date-and-time literal at each position of a record slot a device
 * reads), its export, served on CommCare
 * HQ's own shell, read by the production reader as a read back of a document
 * Nova holds is made (the document's own UUIDs through `matchingResolver`
 * over its identities, and the rest of the reader's input the document's
 * own), reads with no finding and no reader defect, and `readBackDifferences`
 * of `canonDocument(D)` against the reading's document, beside the
 * declarations the reading offers, is empty. A first reading of each
 * temporal-branch export, told no UUID, no property's type and no language's
 * code, as a bring-in is, reads with no finding and no reader defect, and so
 * does a first reading of each typed-literal and record-expression export.
 * The temporal-branch and typed-literal corpora draw their classes in nearly
 * every document, which the record-expression corpus draws in few.
 *
 * Plausible failure: a pair of documents that print one export which the
 * canonical list lacks, a slot the reader reads back as something else, or
 * content the reader adds or drops; a property a first reading leaves
 * untyped, or types by a guess, where it stands only in a branch a record
 * slot compares; a date or date-and-time literal a branch gives, typed in the
 * document and read untyped where nothing beside it gives its type, or read
 * untyped where something does; a typed literal at a position that requires
 * its type (`format-date`'s date, `date-add`'s, a date Search field's
 * starting value) read as text, or one at a position that does not left
 * typed by the canonical form. The rule for a failure is fixed: a sample
 * that reads back to another document whose emission is byte-equal is a pair
 * that joins the canonical list; one whose emission differs, or that reads to
 * an account, is a reader defect corrected in the reader module that owns the
 * slot.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	recordExpressionDocArbitrary,
	recordSlotsOf,
} from "@/lib/commcare/__tests__/recordExpressionArbitrary";
import { suiteDocArbitrary } from "@/lib/commcare/__tests__/suiteDocArbitrary";
import { temporalBranchDocArbitrary } from "@/lib/commcare/__tests__/temporalBranchArbitrary";
import { typedLiteralDocArbitrary } from "@/lib/commcare/__tests__/typedLiteralArbitrary";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import { readHqApp } from "@/lib/commcare/reader";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { whereText } from "@/lib/commcare/reader/place";
import { rebuildFieldParent, toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { readBackDifferences } from "../readBack";
import { readBackInput, servedExport } from "./novaReading";

/** Why `doc` does not read back to its canonical form, or null where it does. */
async function readBackFailure(doc: BlueprintDoc): Promise<string | null> {
	rebuildFieldParent(doc);
	const served = servedExport(doc);
	const outcome = readHqApp(await readBackInput(doc, served));
	if (outcome.defects.length > 0)
		return `reader defect: ${JSON.stringify(outcome.defects[0])}`;
	if (outcome.kind !== "read")
		return `read to an account: ${outcome.findings
			.map(
				(finding) =>
					`${finding.code} at ${whereText(finding.place)} (${finding.detail.name ?? ""})`,
			)
			.join("; ")}`;
	const { declaration } = outcome.draft;
	const expected = canonDocument(
		doc,
		undefined,
		doc.localization?.sourceLanguage,
	);
	const differences = readBackDifferences(expected, {
		doc: outcome.draft.doc,
		choices: declaration.kind === "choices" ? declaration.choices : [],
	});
	return differences.length === 0
		? null
		: `${differences.length} difference(s): ${differences
				.slice(0, 8)
				.map(
					(one) =>
						`${one.kind} /${one.path.join("/")} (want ${at(expected, one.path)}, got ${at(outcome.draft.doc, one.path)})`,
				)
				.join("; ")}`;
}

/** The value at `path` of `doc` as JSON, cut short, for a failure's message. */
function at(doc: BlueprintDoc, path: readonly string[]): string {
	let node: unknown = toPersistableDoc(doc);
	for (const key of path)
		node =
			node !== null && typeof node === "object"
				? (node as Record<string, unknown>)[key]
				: undefined;
	return (JSON.stringify(node) ?? "nothing").slice(0, 160);
}

/** The record-expression corpus's budget per property, over three times
 *  what its sixty runs take alone (a draw asks the gate of every placement
 *  it tries, so the corpus costs more a run than the others). */
const RECORD_BUDGET = 240_000;

describe("a read back of a fuzz document's export", () => {
	// Each run is one expansion, one served source, one whole reading and one
	// canonical form. A temporal-branch or typed-literal run also asks the
	// gate of each placement it draws, so each of those corpora takes half
	// the runs for about the time of the workflow corpus's hundred (some
	// twenty to thirty seconds each, beside another suite). The bound leaves a
	// shared CI runner under load room.
	for (const [name, arbitrary, numRuns, timeout] of [
		["field-tree", blueprintDocArbitrary, 100, 120_000],
		["workflow", suiteDocArbitrary, 100, 120_000],
		["temporal-branch", temporalBranchDocArbitrary, 50, 120_000],
		["typed-literal", typedLiteralDocArbitrary, 50, 120_000],
		["record-expression", recordExpressionDocArbitrary, 60, RECORD_BUDGET],
	] as const)
		it(`gives the document's canonical form, over the ${name} corpus`, {
			timeout,
		}, async () => {
			await fc.assert(
				fc.asyncProperty(arbitrary, async (doc) => {
					const failure = await readBackFailure(doc);
					expect(failure).toBeNull();
				}),
				{ seed: 20261115, numRuns },
			);
		});
});

/** Whether a record slot of `doc` that reads the menu's case (a list's
 *  filter, a form's display condition, a calculated column) holds a
 *  value-giving branch with a case property, or a date or date-and-time
 *  literal, among its values. */
function holdsTemporalBranch(doc: BlueprintDoc): boolean {
	const trees: Expression[] = [];
	for (const module of Object.values(doc.modules)) {
		const config = module.caseListConfig;
		if (config?.filter !== undefined) trees.push(config.filter);
		for (const column of config?.columns ?? [])
			if (column.kind === "calculated") trees.push(column.expression);
	}
	for (const form of Object.values(doc.forms))
		if (form.displayCondition !== undefined) trees.push(form.displayCondition);
	return trees.some((tree) => {
		let found = false;
		walkExpressionNodes(tree, (node) => {
			const values =
				node.kind === "coalesce"
					? node.values
					: node.kind === "if"
						? [node.then, node.else]
						: node.kind === "switch"
							? [...node.cases.map((one) => one.then), node.fallback]
							: [];
			if (
				values.some(
					(value) =>
						value.kind === "datetime-coerce" ||
						(value.kind === "term" &&
							(value.term.kind === "prop" ||
								(value.term.kind === "literal" &&
									value.term.data_type !== undefined))),
				)
			)
				found = true;
		});
		return found;
	});
}

/** Why a first reading of `doc`'s export, told nothing a read back is told
 *  (no UUIDs, no property's type, no language's code), is no reading, or
 *  null where it reads. */
async function firstReadingFailure(doc: BlueprintDoc): Promise<string | null> {
	rebuildFieldParent(doc);
	const served = servedExport(doc);
	const {
		knownCaseTypes: _types,
		knownLanguageCodes: _codes,
		...told
	} = await readBackInput(doc, served);
	const outcome = readHqApp({ ...told, resolver: mintingResolver(doc.appId) });
	if (outcome.defects.length > 0)
		return `reader defect: ${JSON.stringify(outcome.defects[0])}`;
	return outcome.kind === "read"
		? null
		: `read to an account: ${outcome.findings
				.map(
					(finding) =>
						`${finding.code} at ${whereText(finding.place)} (${finding.detail.reason ?? ""})`,
				)
				.join("; ")}`;
}

/** Whether a record slot of `doc` a typed-literal draw places in (a list's
 *  filter, a calculated column, a form's or a menu's display condition, a
 *  Search field's starting value) holds a typed date or date-and-time
 *  literal, or a `datetime-coerce` of a literal, at any depth. */
function holdsTypedLiteral(doc: BlueprintDoc): boolean {
	const trees: Expression[] = [];
	for (const module of Object.values(doc.modules)) {
		const config = module.caseListConfig;
		if (config?.filter !== undefined) trees.push(config.filter);
		for (const column of config?.columns ?? [])
			if (column.kind === "calculated") trees.push(column.expression);
		for (const input of config?.searchInputs ?? [])
			if ("default" in input && input.default !== undefined)
				trees.push(input.default);
		if (module.displayCondition !== undefined)
			trees.push(module.displayCondition);
	}
	for (const form of Object.values(doc.forms))
		if (form.displayCondition !== undefined) trees.push(form.displayCondition);
	return trees.some((tree) => {
		let found = false;
		walkExpressionNodes(tree, (node) => {
			if (
				node.kind === "datetime-coerce" ||
				(node.kind === "term" &&
					node.term.kind === "literal" &&
					(node.term.data_type === "date" ||
						node.term.data_type === "datetime"))
			)
				found = true;
		});
		return found;
	});
}

/** Whether a record slot of `doc` a menu, a list, a search or a form's entry
 *  evaluates holds an expression. */
function holdsRecordExpression(doc: BlueprintDoc): boolean {
	return recordSlotsOf(doc).length > 0;
}

describe("a first reading of a fuzz document's export", () => {
	for (const [name, arbitrary, holds, numRuns, timeout] of [
		[
			"temporal-branch",
			temporalBranchDocArbitrary,
			holdsTemporalBranch,
			50,
			120_000,
		],
		["typed-literal", typedLiteralDocArbitrary, holdsTypedLiteral, 50, 120_000],
		[
			"record-expression",
			recordExpressionDocArbitrary,
			holdsRecordExpression,
			60,
			RECORD_BUDGET,
		],
	] as const)
		it(`reads, over the ${name} corpus, where no export carries a property's type`, {
			timeout,
		}, async () => {
			let drawn = 0;
			await fc.assert(
				fc.asyncProperty(arbitrary, async (doc) => {
					if (holds(doc)) drawn += 1;
					const failure = await firstReadingFailure(doc);
					if (failure !== null) throw new Error(failure);
				}),
				{ seed: 20261115, numRuns },
			);
			// The corpus draws the class it exists for.
			expect(drawn).toBeGreaterThan(numRuns / 2);
		});
});
