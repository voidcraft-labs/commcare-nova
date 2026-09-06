import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import {
	and,
	eq,
	ifExpr,
	literal,
	neq,
	prop,
	switchCase,
	switchExpr,
	term,
} from "@/lib/domain/predicate";
import { searchEmissionFixture } from "./searchEmissionFixture";

/** Opposite branches under the same four native equality conditions. The unsafe
 * document must fail admission; its pre-fix exported suite is retained separately. */
export function csqlStaticQuoteFixture(selected: "safe" | "unsafe") {
	const doc = structuredClone(searchEmissionFixture("remote"));
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config) throw new Error("Search fixture needs a case list");
	const bad = term(literal(`it's "quoted"`));
	const safe = term(literal("safe"));
	const chosen = selected === "safe" ? safe : bad;
	const dead = selected === "safe" ? bad : safe;
	const [first, second, ...rest] = [
		ifExpr(eq(literal(null), literal("")), chosen, dead),
		ifExpr(neq(literal(null), literal("")), dead, chosen),
		switchExpr(term(literal(null)), [switchCase(literal(""), chosen)], dead),
		ifExpr(eq(literal(0), literal(0.0000000000001)), chosen, dead),
	];
	config.searchInputs = [];
	config.filter = and(
		eq(prop("patient", "first_name"), first),
		eq(prop("patient", "first_name"), second),
		...rest.map((value) => eq(prop("patient", "first_name"), value)),
	);
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
