/**
 * A search's `_xpath_query` rows against Nova's own emission of a proposed
 * menu. The contract: every row Nova writes for the menu matches the same
 * row exact, in order, each named by the source that wrote it (the case list
 * filter, an advanced field's condition, a simple field's derived match); a
 * row Nova does not write is unmatched and a row Nova writes that the source
 * lacks is extra; a row whose root is `and` reads as its conjuncts. The
 * failures this catches: Nova's own rows not matched exact, a filter's clause
 * that reads a Search field reported as a field's row, and a conjunction read
 * as one predicate.
 */
import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	gt,
	input,
	literal,
	prop,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { Expression } from "@/lib/domain/expression/types";
import { composeModuleXPathQueryEmission } from "../../../suite/case-search/moduleXPathQuery";
import { xpathQueryRequestValues } from "../../../suite/case-search/xpathQuery";
import { serializeWire } from "../../../xpath/wire/serialize";
import { matchSearchRows, readSearchRowConjuncts } from "../searchRows";
import {
	csqlRow,
	csqlVectorDoc,
	patientsMenu,
	REGION,
	rowContext,
	rowEnv,
} from "./csqlVectors";

const village = prop("patient", "village");
const age = prop("patient", "age");

/** Nova's own `_xpath_query` rows of the vector document's menu, as the HQ JSON holds them. */
function novaRows(filter: Expression): {
	readonly doc: ReturnType<typeof csqlVectorDoc>;
	readonly rows: readonly string[];
} {
	const doc = csqlVectorDoc(filter);
	const menu = patientsMenu(doc);
	const config = doc.modules[menu]?.caseListConfig;
	if (config === undefined) throw new Error("The menu has no case list.");
	const rows = xpathQueryRequestValues(
		config,
		composeModuleXPathQueryEmission(doc, menu, {
			searchInputInstanceId: "search-input:results",
		}),
	).map(
		(value) =>
			serializeWire(value, { target: "hq-json", interpolation: "none" }).text,
	);
	return { doc, rows };
}

describe("a menu's search rows against Nova's emission", () => {
	it("matches every row Nova writes, exact and in order, by the source that wrote it", () => {
		const filter = and(
			gt(age, term(literal(3))),
			whenInput(input(REGION), eq(village, term(input(REGION)))),
		);
		const { doc, rows } = novaRows(filter);
		// The filter's two conjuncts, the field's condition, the date's derived match.
		expect(rows).toHaveLength(4);
		expect(matchSearchRows(doc, patientsMenu(doc), rows, rowEnv(doc))).toEqual({
			matched: [
				{ source: 0, level: "exact", from: "filter" },
				{ source: 1, level: "exact", from: "filter" },
				{ source: 2, level: "exact", from: "field" },
				{ source: 3, level: "exact", from: "derived" },
			],
			unmatched: [],
			extra: [],
		});
	});

	it("names a row the source holds and Nova does not write, and a row Nova writes the source lacks", () => {
		const { doc, rows } = novaRows(gt(age, term(literal(3))));
		const source = [csqlRow("village = 'elsewhere'"), ...rows.slice(1)];
		const result = matchSearchRows(doc, patientsMenu(doc), source, rowEnv(doc));
		expect(result.unmatched).toEqual([0]);
		expect(result.extra).toEqual([0]);
		expect(result.matched.map((entry) => entry.from)).toEqual([
			"field",
			"derived",
		]);
	});
});

describe("a row read on its own", () => {
	it("reads a row whose root is a conjunction as its conjuncts", () => {
		const doc = csqlVectorDoc();
		const reading = readSearchRowConjuncts(
			csqlRow("village = 'a' and age > 3"),
			rowContext(doc),
			rowEnv(doc),
		);
		expect(reading).toEqual({
			ok: true,
			conjuncts: [eq(village, term(literal("a"))), gt(age, term(literal(3)))],
			rewrites: [],
		});
	});

	it("answers a refusal as the row's own reading does", () => {
		const doc = csqlVectorDoc();
		expect(
			readSearchRowConjuncts(
				csqlRow("today() = village"),
				rowContext(doc),
				rowEnv(doc),
			),
		).toMatchObject({
			ok: false,
			claim: {
				entryId:
					"case-search/a-function-on-the-left-side-a-property-on-the-right-side",
			},
		});
	});
});
