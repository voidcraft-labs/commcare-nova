import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { advancedSearchInputDef, blueprintDocSchema } from "@/lib/domain";
import {
	and,
	concat,
	eq,
	ifExpr,
	input,
	literal,
	matchAll,
	neq,
	not,
	or,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { runValidation } from "../validator/runner";
import { searchEmissionFixture } from "./searchEmissionFixture";

/** One admitted app exercises complete queries under ordinary, negated, OR,
 * nested presence and computed-value composition. Native Core owns the answers. */
export function csqlQuoteFixture() {
	const doc = structuredClone(searchEmissionFixture("remote"));
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config) throw new Error("Search fixture needs a case list");
	const queryId = testUuid("quote-query");
	const suffixId = testUuid("quote-suffix");
	const query = input(queryId),
		suffix = input(suffixId);
	const firstName = prop("patient", "first_name");
	const active = eq(prop("patient", "case_name"), literal("active"));
	const equal = eq(firstName, query);
	config.searchInputs = [
		advancedSearchInputDef(queryId, "query", "Name", "text", matchAll()),
		advancedSearchInputDef(suffixId, "suffix", "Suffix", "text", matchAll()),
	];
	config.filter = and(
		whenInput(query, equal),
		whenInput(query, neq(firstName, query)),
		whenInput(query, not(equal)),
		whenInput(query, or(equal, active)),
		or(whenInput(query, not(equal)), active),
		whenInput(
			query,
			whenInput(
				suffix,
				eq(
					firstName,
					ifExpr(
						eq(query, literal("fallback")),
						term(literal("fixed")),
						concat(term(query), term(literal(" ")), term(suffix)),
					),
				),
			),
		),
	);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
	if (findings.length) throw new Error(JSON.stringify(findings));
	return doc;
}
