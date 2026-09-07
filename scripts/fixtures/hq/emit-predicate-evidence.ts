/** Private predicate emitter probes, consumed by Core; no whole-app claim. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { testUuid } from "../../../__tests__/helpers/uuid";
import { emitCaseListFilter } from "../../../lib/commcare/predicate/caseListFilterEmitter";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	eq,
	exists,
	gt,
	gte,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchesPattern,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	term,
	whenInput,
	within,
} from "../../../lib/domain/predicate/builders";
import {
	type Predicate,
	predicateSchema,
} from "../../../lib/domain/predicate/types";

const output = process.argv[2];
if (!output) throw new Error("Pass an output directory.");
mkdirSync(output, { recursive: true });
const query = testUuid("predicate-native-query");
const rows: string[] = [];
const b64 = (value: string) => Buffer.from(value).toString("base64");
function probe(
	id: string,
	predicate: Predicate,
	expected: boolean,
	location = "40.7 -74.0",
	queryPresent = true,
) {
	predicateSchema.parse(predicate);
	const xpath = emitCaseListFilter(predicate, "casedb", {
		knownInputs: [{ uuid: query, name: "query", data_type: "text" }],
	});
	rows.push(
		[
			id,
			String(expected),
			b64(xpath),
			b64(location),
			String(queryPresent),
		].join("\t"),
	);
}
const name = prop("patient", "case_name");
const age = prop("patient", "age");
probe("equality", eq(name, literal(`O'Brien "quoted"`)), true);
probe("inequality", neq(name, literal(`O'Brien "quoted"`)), false);
probe("greater", gt(age, literal(17)), true);
probe("greater-equal", gte(age, literal(18)), true);
probe("less", lt(age, literal(18)), false);
probe("less-equal", lte(age, literal(18)), true);
probe(
	"precedence",
	and(or(eq(age, literal(18)), eq(age, literal(20))), gt(age, literal(19))),
	false,
);
probe("not", not(eq(age, literal(18))), false);
probe("null-is-empty", eq(prop("patient", "empty"), literal(null)), true);
probe("blank", isBlank(prop("patient", "empty")), true);
probe("boolean", eq(prop("patient", "active"), literal(true)), true);
probe(
	"set-whitespace",
	isIn(prop("patient", "full_name"), literal("Alice Smith"), literal("Bob")),
	true,
);
probe(
	"set-token-counterexample",
	isIn(prop("patient", "full_name"), literal("Alice"), literal("Bob")),
	false,
);
probe(
	"between-inclusive",
	between(age, { lower: literal(18), upper: literal(18) }),
	true,
);
probe(
	"between-exclusive",
	between(age, {
		lower: literal(18),
		upper: literal(19),
		lowerInclusive: false,
	}),
	false,
);
probe(
	"between-upper-only",
	between(age, { upper: literal(18), upperInclusive: false }),
	false,
);
probe(
	"selected-any",
	multiSelectAny(prop("patient", "tags"), literal("vip"), literal("missing")),
	true,
);
probe(
	"selected-all",
	multiSelectAll(prop("patient", "tags"), literal("vip"), literal("missing")),
	false,
);
probe("prefix", match(name, "O'", "starts-with"), true);
probe("regex-unanchored", matchesPattern(name, "Brien"), true);
probe("regex-negative", matchesPattern(name, "^Brien"), false);
probe("sentinel-all", matchAll(), true);
probe("sentinel-none", matchNone(), false);
probe("arith", eq(arith("+", term(age), term(literal(1))), literal(19)), true);
probe(
	"derived-value",
	eq(
		name,
		ifExpr(
			matchAll(),
			term(literal(`O'Brien "quoted"`)),
			term(literal("wrong")),
		),
	),
	true,
);
probe(
	"worker-data",
	eq(prop("patient", "region"), sessionUser("region")),
	true,
);
probe(
	"worker-context",
	eq(prop("patient", "username"), sessionContext("username")),
	true,
);
probe(
	"query-present-false",
	whenInput(input(query), eq(age, literal(99))),
	false,
);
probe(
	"query-missing-identity",
	whenInput(input(query), eq(age, literal(99))),
	true,
	undefined,
	false,
);
probe("query-value", eq(prop("patient", "region"), input(query)), true);
probe(
	"reserved-attribute",
	eq(prop("patient", "case_id"), literal("patient-1")),
	true,
);
probe(
	"ancestor",
	exists(
		ancestorPath(relationStep("parent", "household")),
		eq(prop("household", "region"), literal("south")),
	),
	true,
);
probe(
	"ancestor-wrong-value",
	exists(
		ancestorPath(relationStep("parent", "household")),
		eq(prop("household", "region"), literal("north")),
	),
	false,
);
probe(
	"child",
	exists(
		subcasePath("parent", "visit"),
		eq(prop("visit", "outcome"), literal("open")),
	),
	true,
);
probe(
	"child-same-row",
	exists(
		subcasePath("parent", "visit"),
		and(
			eq(prop("visit", "outcome"), literal("open")),
			eq(prop("visit", "rating"), literal(5)),
		),
	),
	false,
);
probe(
	"missing-child",
	missing(
		subcasePath("parent", "visit"),
		eq(prop("visit", "outcome"), literal("unknown")),
	),
	true,
);
probe("self", exists(selfPath(), eq(age, literal(18))), true);
probe("missing-self", missing(selfPath()), false);
probe(
	"either-direction",
	exists(
		anyRelationPath("parent"),
		eq(prop("patient", "region"), literal("south")),
	),
	true,
);
for (const [id, location, expected] of [
	["coincident", "40.7 -74.0", true],
	["distant", "0 0", false],
	["blank", "", false],
	["malformed", "nonsense", false],
	["latitude-outside", "91 -74", false],
	["longitude-outside", "40.7 -181", false],
	["stored-comma-refused", "40.7,-74.0", false],
	["altitude-accuracy", "40.7 -74.0 0 5", true],
] as const)
	probe(
		`distance-${id}`,
		within(prop("patient", "location"), literal("40.7,-74.0"), 1, "miles"),
		expected,
		location,
	);
probe(
	"distance-kilometers",
	within(
		prop("patient", "location"),
		literal("40.7 -74.0"),
		0.001,
		"kilometers",
	),
	true,
);
probe(
	"distance-derived-center",
	within(
		prop("patient", "location"),
		ifExpr(matchAll(), term(literal("40.7,-74.0")), term(literal("0,0"))),
		1,
		"miles",
	),
	true,
);
probe(
	"distance-bad-center",
	within(prop("patient", "location"), literal("91,0"), 1, "miles"),
	false,
);
// Approximately 1.11 km: distinguishes kilometer and mile conversion at the
// same one-unit radius, without depending on an unstable exact boundary.
probe(
	"distance-one-km-outside",
	within(prop("patient", "location"), literal("0,0"), 1, "kilometers"),
	false,
	"0.01 0",
);
probe(
	"distance-one-mile-inside",
	within(prop("patient", "location"), literal("0,0"), 1, "miles"),
	true,
	"0.01 0",
);
writeFileSync(resolve(output, "predicate-corpus.tsv"), rows.join("\n") + "\n");
writeFileSync(
	resolve(output, "predicate-corpus-count.txt"),
	String(rows.length),
);
console.log(`Produced ${rows.length} schema-parsed private predicate probes.`);
