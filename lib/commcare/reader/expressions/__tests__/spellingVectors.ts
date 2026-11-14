/**
 * The vectors Core reads each row of the reader's equivalence table with
 * (`syntaxCompare.ts`): two spellings of one expression, evaluated over one
 * instance, which must answer alike. The expression producer writes them as
 * `/expression/reader-spelling.json`, and
 * `proof/native/core/ReaderSpellingRuntimeTest.java` parses each spelling
 * with Core's own `XPathParseTool.parseXPath` and evaluates both.
 *
 * The main instance is `/data` holding `a` (`1`), `b` (`2`), `c` (`x y`) and
 * three `x` rows (`a`, `b`, `c`), the first with an `id` attribute (`r1`).
 * The `casedb` vectors read a case database holding one case, `c1`, named
 * `Asha`. A vector marked `apart` is a negative control: Core answers its
 * two spellings differently, and the table holds no row for them.
 */
export interface SpellingVector {
	/** The table's row, or the negative control's. */
	readonly row: "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "S1" | "name";
	readonly name: string;
	readonly a: string;
	readonly b: string;
	/** Whether the two spellings read the case database. */
	readonly casedb?: true;
	/** Core answers the two apart: each spelling's own answer. */
	readonly apart?: { readonly a: string; readonly b: string };
}

const CASE = "instance('casedb')/casedb/case[@case_id = 'c1']";

export const SPELLING_VECTORS: readonly SpellingVector[] = [
	{ row: "L1", name: "no space and a space", a: "1+1", b: "1 + 1" },
	{
		row: "L1",
		name: "two spaces and a line feed",
		a: "/data/a  =\n'1'",
		b: "/data/a = '1'",
	},
	{
		row: "L1",
		name: "a tab and a form feed",
		a: "/data/a\t=\f'1'",
		b: "/data/a = '1'",
	},
	{
		row: "L1",
		name: "spaces inside a call",
		a: "selected( /data/c ,'x' )",
		b: "selected(/data/c, 'x')",
	},
	{ row: "L2", name: "a grouped sum", a: "(1 + 2) * 3", b: "(1+2)*3" },
	{
		row: "L2",
		name: "a doubly grouped read",
		a: "((/data/a))",
		b: "/data/a",
	},
	{
		row: "L2",
		name: "a grouped comparison",
		a: "(/data/a = /data/b)",
		b: "/data/a = /data/b",
	},
	{ row: "L3", name: "single and double quotes", a: "'a'", b: '"a"' },
	{
		row: "L3",
		name: "a comparison of the two marks",
		a: "'a' = \"a\"",
		b: "\"a\" = 'a'",
	},
	{ row: "L4", name: "a whole number and its decimal", a: "1", b: "1.0" },
	{ row: "L4", name: "a leading zero", a: "01", b: "1" },
	{ row: "L4", name: "a fraction with no whole part", a: ".5", b: "0.5" },
	{ row: "L4", name: "a trailing point", a: "1.", b: "1" },
	{ row: "L5", name: "the child axis", a: "/data/child::a", b: "/data/a" },
	{
		row: "L5",
		name: "the self axis",
		a: "/data/x[1]/self::node()",
		b: "/data/x[1]/.",
	},
	{
		row: "L5",
		name: "the parent axis",
		a: "/data/x[1]/parent::node()/a",
		b: "/data/x[1]/../a",
	},
	{
		row: "L5",
		name: "the attribute axis, a control",
		a: "/data/x[1]/attribute::id",
		b: "/data/x[1]/@id",
	},
	{
		row: "L6",
		name: "a predicate's own node",
		a: "count(/data/x[. = 'a'])",
		b: "count(/data/x[./. = 'a'])",
	},
	{
		row: "S1",
		name: "three arguments, true first",
		a: "cond(true(), 'a', 'b')",
		b: "if(true(), 'a', 'b')",
	},
	{
		row: "S1",
		name: "three arguments, none true",
		a: "cond(false(), 'a', 'b')",
		b: "if(false(), 'a', 'b')",
	},
	{
		row: "S1",
		name: "five arguments, true second",
		a: "cond(/data/a = '2', 'a', /data/b = '2', 'b', 'c')",
		b: "if(/data/a = '2', 'a', if(/data/b = '2', 'b', 'c'))",
	},
	{
		row: "S1",
		name: "five arguments, none true",
		a: "cond(false(), 'a', false(), 'b', 'c')",
		b: "if(false(), 'a', if(false(), 'b', 'c'))",
	},
	{
		row: "S1",
		name: "a branch that would throw is never evaluated",
		a: "cond(true(), 'a', date('not a date'))",
		b: "if(true(), 'a', date('not a date'))",
	},
	{
		row: "name",
		name: "a case's name read as name and as case_name",
		a: `${CASE}/case_name`,
		b: `${CASE}/name`,
		casedb: true,
		apart: { a: "Asha", b: "" },
	},
	{
		row: "name",
		name: "a case's name tested as name and as case_name",
		a: "count(instance('casedb')/casedb/case[case_name = 'Asha'])",
		b: "count(instance('casedb')/casedb/case[name = 'Asha'])",
		casedb: true,
		apart: { a: "1", b: "0" },
	},
];
