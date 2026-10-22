import { describe, expect, it } from "vitest";
import {
	collectOracleInstanceRefs,
	validateSuite,
} from "../validator/suiteOracle";
import {
	detailWire,
	entryWire,
	fieldWire,
	suiteOracleCases,
	suiteWire,
} from "./suiteOracleCorpus";

const codes = (xml: string, locales: readonly string[] = []) =>
	validateSuite(xml, new Set(locales)).map((error) => error.code);
describe("suite wire parser checks and explicit static joins", () => {
	it.each(suiteOracleCases)("$name", ({ xml, codes: expected }) =>
		expect(codes(xml)).toEqual(expected),
	);
	it("rejects malformed XML before any structural scan", () =>
		expect(codes("<suite><detail></suite>")).toEqual(["SUITE_PARSE_ERROR"]));
	for (const id of [
		"casedb",
		"commcaresession",
		"results",
		"results:inline",
		"search-input:results",
		"search-input:results:inline",
	])
		it(`requires ${id} on an ordinary entry`, () => {
			const session = `<session><datum id="d" nodeset="instance('${id}')/items/item" value="./@id"/></session>`;
			expect(codes(suiteWire(entryWire(session)))).toEqual([
				"SUITE_MISSING_INSTANCE",
			]);
			expect(
				codes(
					suiteWire(
						entryWire(
							`<instance id="${id}" src="jr://instance/casedb"/>${session}`,
						),
					),
				),
			).toEqual([]);
		});
	it("joins computed and multiple-selection datums and query exclusions", () => {
		for (const expression of [
			`<datum id="d" function="count(instance('missing')/x)"/>`,
			`<instance-datum id="d" nodeset="instance('missing')/x" value="./@id"/>`,
		]) {
			expect(
				codes(suiteWire(entryWire(`<session>${expression}</session>`))),
			).toEqual(["SUITE_MISSING_INSTANCE"]);
		}
		expect(
			codes(
				suiteWire(
					entryWire(
						`<post url="https://example.org"><data key="q" ref="'x'" exclude="count(instance('missing')/x)"/></post>`,
					),
				),
			),
		).toEqual(["SUITE_MISSING_INSTANCE"]);
	});
	it("joins cchq.case to the emitted table just like every other locale", () => {
		const xml = suiteWire(
			detailWire().replace(
				"<text>Cases</text>",
				'<text><locale id="cchq.case"/></text>',
			),
		);
		expect(codes(xml)).toEqual(["SUITE_MISSING_LOCALE"]);
		expect(codes(xml, ["cchq.case"])).toEqual([]);
	});
	const declaration = '<instance id="lookup" src="jr://fixture/table"/>';
	const fixture = '<fixture id="table"><items><item id="1"/></items></fixture>';
	const expression = "instance('lookup')/items/item";
	const menu = (body: string, id = "m", relevant?: string) =>
		`<menu id="${id}"${relevant === undefined ? "" : ` relevant="${relevant}"`}><text>Menu</text>${body}</menu>`;
	const command = (id = "c", relevant?: string) =>
		`<command id="${id}"${relevant === undefined ? "" : ` relevant="${relevant}"`}/>`;
	it("uses the first same-id menu command entry before a direct same-id entry", () => {
		const xml =
			fixture +
			entryWire(declaration) +
			entryWire("", "nested") +
			menu(command("c", expression)) +
			menu(command("nested"), "c");
		expect(codes(suiteWire(xml))).toEqual([
			"SUITE_MISSING_INSTANCE",
			"SUITE_UNREAD_INSTANCE",
		]);
		const fixed =
			fixture +
			entryWire("") +
			entryWire(declaration, "nested") +
			menu(command("c", expression)) +
			menu(command("nested"), "c");
		expect(codes(suiteWire(fixed))).toEqual([]);
	});
	it("uses a same-id menu declaration but does not inherit the containing menu", () => {
		const xml =
			fixture + entryWire() + menu(declaration + command("c", expression));
		expect(codes(suiteWire(xml))).toEqual([
			"SUITE_MISSING_INSTANCE",
			"SUITE_UNREAD_INSTANCE",
		]);
		expect(codes(suiteWire(xml + menu(declaration, "c")))).toEqual([
			"SUITE_UNREAD_INSTANCE",
		]);
		expect(
			codes(
				suiteWire(
					fixture +
						entryWire() +
						menu(command("c", expression)) +
						menu(declaration, "c"),
				),
			),
		).toEqual([]);
	});
	it("resolves menu relevance from its first command and falls back to its same-id entry", () => {
		expect(
			codes(
				suiteWire(
					fixture + entryWire(declaration) + menu(command(), "m", expression),
				),
			),
		).toEqual([]);
		expect(
			codes(
				suiteWire(
					fixture + entryWire(declaration, "m") + menu("", "m", expression),
				),
			),
		).toEqual([]);
		expect(
			codes(
				suiteWire(fixture + entryWire() + menu(command(), "m", expression)),
			),
		).toEqual(["SUITE_MISSING_INSTANCE"]);
	});
	it("requires detail references in every loading entry and skips an unreachable detail", () => {
		const detail = detailWire(
			fieldWire().replace('function="name"', `function="${expression}"`),
		);
		const session =
			'<session><datum id="d" nodeset="/x" value="./@id" detail-select="d"/></session>';
		expect(
			codes(
				suiteWire(
					fixture +
						detail +
						entryWire(declaration + session) +
						entryWire(session, "b"),
				),
			),
		).toEqual(["SUITE_MISSING_INSTANCE"]);
		expect(
			codes(
				suiteWire(
					fixture +
						detail +
						entryWire(declaration + session) +
						entryWire(declaration + session, "b"),
				),
			),
		).toEqual([]);
		expect(codes(suiteWire(fixture + detail + entryWire()))).toEqual([]);
	});
	it("reports duplicate declarations in the actual entry and menu scopes", () => {
		expect(
			codes(
				suiteWire(
					fixture +
						entryWire(
							declaration +
								declaration +
								`<session><datum id="count" function="count(${expression})"/></session>`,
						) +
						menu(declaration + declaration, "m", expression),
				),
			),
		).toEqual(["SUITE_DUPLICATE_INSTANCE", "SUITE_DUPLICATE_INSTANCE"]);
	});
	it("reads real instance calls independently of literal prose and invalid XPath", () => {
		expect(
			collectOracleInstanceRefs(
				`concat("instance('prose')", instance('real')/items)`,
			),
		).toEqual(new Set(["real"]));
		for (const source of [
			`"instance('prose')"`,
			"instance('a', 'b')",
			"instance(concat('a', 'b'))",
			"instance('a')/[",
		]) {
			expect(collectOracleInstanceRefs(source)).toEqual(new Set());
		}
	});
	it("does not let another entry's read consume an unused declaration", () => {
		const unused = entryWire(declaration, "unused");
		const reading = entryWire(
			`<session><datum id="d" function="count(${expression})"/></session>`,
			"reading",
		);
		expect(codes(suiteWire(fixture + unused + reading))).toEqual([
			"SUITE_MISSING_INSTANCE",
			"SUITE_UNREAD_INSTANCE",
		]);
	});
	it.each([
		`<required test="${expression}"><text>Needed</text></required>`,
		`<validation test="${expression}"><text>Invalid</text></validation>`,
		`<itemset nodeset="${expression}"><label ref="name"/><value ref="@id"/></itemset>`,
		`<itemset nodeset="/items/item"><label ref="${expression}"/><value ref="@id"/></itemset>`,
		`<itemset nodeset="/items/item"><label ref="name"/><value ref="${expression}"/></itemset>`,
		`<itemset nodeset="/items/item"><label ref="name"/><value ref="@id"/><sort ref="${expression}"/></itemset>`,
	])("joins the search prompt read in %s", (content) => {
		const query = `<session><query url="https://example.org/search" storage-instance="results"><prompt key="q" input="q"><display><text>Question</text></display>${content}</prompt></query></session>`;
		expect(codes(suiteWire(fixture + entryWire(declaration + query)))).toEqual(
			[],
		);
		expect(codes(suiteWire(fixture + entryWire(query)))).toEqual([
			"SUITE_MISSING_INSTANCE",
		]);
	});
	it("joins assertion and nested detail reads to their actual loading entry", () => {
		const assertion = `<assertions><assert test="${expression}"><text>Required</text></assert></assertions>`;
		expect(
			codes(suiteWire(fixture + entryWire(declaration + assertion))),
		).toEqual([]);
		const nested = detailWire(
			detailWire(
				fieldWire().replace('function="name"', `function="${expression}"`),
				"nested",
			),
		);
		const session =
			'<session><datum id="d" nodeset="/x" value="./@id" detail-select="d"/></session>';
		expect(
			codes(suiteWire(fixture + nested + entryWire(declaration + session))),
		).toEqual([]);
		expect(codes(suiteWire(fixture + nested + entryWire(session)))).toEqual([
			"SUITE_MISSING_INSTANCE",
		]);
	});
	it("counts detail grouping and relevance as reads in each referring entry", () => {
		const session =
			'<session><datum id="d" nodeset="/x" value="./@id" detail-select="d"/></session>';
		for (const detail of [
			detailWire(fieldWire(), "d").replace(
				'id="d"',
				`id="d" relevant="${expression}"`,
			),
			detailWire(`${fieldWire()}<group function="${expression}"/>`),
		]) {
			expect(
				codes(suiteWire(fixture + detail + entryWire(declaration + session))),
			).toEqual([]);
			expect(codes(suiteWire(fixture + detail + entryWire(session)))).toEqual([
				"SUITE_MISSING_INSTANCE",
			]);
		}
	});
	it("keeps fixture data, prose and stack query URLs out of the read set", () => {
		const fixtureData =
			'<fixture id="table"><items><xpath function="instance(\'lookup\')/items"/></items></fixture>';
		const prose =
			'<session><datum id="d" function="&quot;instance(\'lookup\')&quot;"/></session>';
		const query =
			'<stack><create><query id="q" value="https://example.org/instance(\'lookup\')"/></create></stack>';
		expect(
			codes(suiteWire(fixtureData + entryWire(declaration + prose + query))),
		).toEqual(["SUITE_UNREAD_INSTANCE"]);
	});
	it("counts session selection values but ignores their value when a function takes precedence", () => {
		const selected = `<session><datum id="d" nodeset="/x" value="${expression}"/></session>`;
		expect(
			codes(suiteWire(fixture + entryWire(declaration + selected))),
		).toEqual([]);
		const computed = selected.replace(
			'nodeset="/x"',
			'function="1" nodeset="/x"',
		);
		expect(
			codes(suiteWire(fixture + entryWire(declaration + computed))),
		).toEqual(["SUITE_UNREAD_INSTANCE"]);
	});
	it("ignores expression-shaped attributes Core does not evaluate", () => {
		const content = `<display><text function="${expression}">Label</text></display><stack><create value="${expression}"><command value="'next'"/></create></stack>`;
		expect(
			codes(suiteWire(fixture + entryWire(declaration + content))),
		).toEqual(["SUITE_UNREAD_INSTANCE"]);
	});
	it("joins both menu locale values and image-map string literals to archive media", () => {
		const pathA = "commcare/a.png",
			pathB = "commcare/b.png";
		const xml = suiteWire(
			menu(
				'<display><text>Menu</text><text form="image"><locale id="icon"/></text></display>',
			) +
				detailWire(
					fieldWire()
						.replace("<template>", '<template form="image">')
						.replace(
							'function="name"',
							`function="if(selected(name, 'a'), 'jr://file/${pathA}', 'jr://file/${pathB}')"`,
						),
				),
		);
		const values = new Map([["icon", `jr://file/${pathA}`]]);
		expect(
			validateSuite(xml, new Set(["icon"]), {
				appStringValues: values,
				manifest: new Set([pathA, pathB]),
			}),
		).toEqual([]);
		const errors = validateSuite(xml, new Set(["icon"]), {
			appStringValues: values,
			manifest: new Set([pathA]),
		});
		expect(errors.map((error) => error.code)).toEqual([
			"SUITE_DANGLING_MEDIA_REF",
		]);
		expect(errors[0].message).toContain(pathB);
	});
});
