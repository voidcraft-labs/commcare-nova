/**
 * Contract: each Search field Nova emits reads back into its slots, and the prompts HQ's pages
 * write that Nova cannot write back raise their entries. The failure it catches: a prompt key read
 * into the wrong slot; a required message stored where it is the default; a simple field read as
 * advanced; a prompt Nova cannot write back read as held.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { localizationWireFixture } from "@/lib/commcare/__tests__/localizationWireFixture";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	neq,
	or,
	prop,
	tableColumn,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { expandDoc } from "../../../expander";
import { lookupWireNaming } from "../../../lookup/naming";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	codes,
	comparableList,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";
import { readHqApp } from "../../index";
import { readFormSyntax } from "../../syntaxRead";
import type { ReaderInput } from "../../types";
import { exactSearchModeIsAbsent } from "../prompts";

async function roundTrip(inputs: SearchInputDef[]) {
	const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: inputs,
		search: {},
	});
	const reading = await readLists(doc);
	return {
		reading,
		read: comparableList(listOf(reading)) as { searchInputs: unknown[] },
	};
}

/** The authored fields without their uuids, each Search field read named by the uuid the
 *  reading minted for the field at its place. */
function asRead(
	inputs: readonly SearchInputDef[],
	reading: Awaited<ReturnType<typeof readLists>>,
): unknown[] {
	const minted = listOf(reading).searchInputs.map((one) => one.uuid);
	let text = JSON.stringify(inputs.map(({ uuid: _uuid, ...rest }) => rest));
	inputs.forEach((one, index) => {
		const read = minted[index];
		if (read !== undefined) text = text.split(one.uuid).join(read);
	});
	return JSON.parse(text) as unknown[];
}

describe("Search fields Nova emits", () => {
	it("reads a text field with a hint and a required message", async () => {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			hint: "Part of the notes",
			required: { message: "Say something" },
			kind: "simple",
			type: "text",
			property: "notes",
		};
		const { reading, read } = await roundTrip([input]);
		expect(codes(reading)).toEqual([]);
		const { uuid: _uuid, ...rest } = input;
		expect(read.searchInputs).toEqual([rest]);
	});

	it("reads a required field with Nova's default message as an absent message", async () => {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			required: {},
			kind: "simple",
			type: "text",
			property: "notes",
		};
		const { reading, read } = await roundTrip([input]);
		expect(codes(reading)).toEqual([]);
		expect(read.searchInputs).toEqual([
			{
				name: "notes",
				label: "Notes",
				required: {},
				kind: "simple",
				type: "text",
				property: "notes",
			},
		]);
	});

	it("reads a barcode field and a date range field", async () => {
		const inputs: SearchInputDef[] = [
			{
				uuid: uuid(9),
				name: "phone",
				label: "Phone",
				kind: "simple",
				type: "barcode",
				property: "phone",
			},
			{
				uuid: uuid(10),
				name: "dob",
				label: "Born",
				kind: "simple",
				type: "date-range",
				property: "dob",
				mode: { kind: "range" },
			},
		];
		const { reading, read } = await roundTrip(inputs);
		expect(codes(reading)).toEqual([]);
		expect(read.searchInputs).toEqual(
			inputs.map(({ uuid: _uuid, ...rest }) => rest),
		);
	});
});

describe("each Search field's slots and arm", () => {
	const text = (extra: Partial<SearchInputDef>): SearchInputDef =>
		({
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			kind: "simple",
			type: "text",
			property: "notes",
			...extra,
		}) as SearchInputDef;

	const cases: [string, SearchInputDef[]][] = [
		[
			"a field with a starting value",
			[text({ default: term(literal("well")) })],
		],
		[
			"a field with a validation rule",
			[
				text({
					validation: {
						rule: neq(input(uuid(9)), literal("none")),
						message: "Say more",
					},
				}),
			],
		],
		[
			"a hidden value beside a visible field",
			[
				text({}),
				{
					uuid: uuid(10),
					kind: "hidden",
					name: "region",
					label: "Region",
					value: term(literal("north")),
				},
			],
		],
		[
			"a field over the owner, written excluded with its own row",
			[text({ name: "owner_id", label: "Owner", property: "owner_id" })],
		],
		[
			"a field whose condition reads two properties",
			[
				{
					uuid: uuid(9),
					name: "anything",
					label: "Anything",
					kind: "advanced",
					type: "text",
					predicate: whenInput(
						input(uuid(9)),
						or(
							eq(prop("patient", "notes"), input(uuid(9))),
							eq(prop("patient", "phone"), input(uuid(9))),
						),
					),
				},
			],
		],
		[
			"a field no filter reads",
			[
				{
					uuid: uuid(9),
					name: "anything",
					label: "Anything",
					kind: "advanced",
					type: "text",
					predicate: matchAll(),
				},
			],
		],
	];
	for (const [name, inputs] of cases)
		it(`reads ${name}`, async () => {
			const { reading, read } = await roundTrip(inputs);
			expect(codes(reading)).toEqual([]);
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
		});

	it("raises a date range field over a property a text question saves", async () => {
		const { reading } = await roundTrip([
			{
				uuid: uuid(9),
				name: "notes",
				label: "Notes",
				kind: "simple",
				type: "date-range",
				property: "notes",
				mode: { kind: "range" },
			},
		]);
		const finding = reading.findings.find(
			(one) =>
				one.code === "case-search/search-field-over-a-property-of-another-type",
		);
		expect(finding?.detail.name).toBe("notes");
	});

	it("declares a date range field's property `date` where no question types it", async () => {
		const { reading } = await roundTrip([
			{
				uuid: uuid(9),
				name: "due",
				label: "Due",
				kind: "simple",
				type: "date-range",
				property: "due",
				mode: { kind: "range" },
			},
		]);
		expect(codes(reading)).toEqual([]);
		const due = reading.ctx.doc?.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((property) => property.name === "due");
		expect(due?.data_type).toBe("date");
	});
});

describe("prompts HQ's pages write that Nova does not", () => {
	async function edited(change: Record<string, unknown>) {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			kind: "simple",
			type: "text",
			property: "notes",
		};
		return readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [input],
				search: {},
			}),
			{
				edit: (app) => {
					const properties = app.modules[0]?.search_config.properties as Record<
						string,
						unknown
					>[];
					if (properties[0] !== undefined) Object.assign(properties[0], change);
				},
				firstPassOnly: true,
			},
		);
	}

	for (const name of ["owner_id", "case_id", "status"])
		it(`raises a bare prompt named ${name}`, async () => {
			const reading = await edited({ name });
			expect(codes(reading)).toContain(
				"case-search/prompt-named-for-a-case-attribute-hq-matches-itself",
			);
		});

	it("raises a bare date prompt", async () => {
		const reading = await edited({ input_: "date" });
		expect(codes(reading)).toContain(
			"case-search/date-prompt-matched-by-hq-s-own-rule",
		);
	});

	it("raises a second validation", async () => {
		const reading = await edited({
			validations: [
				{ test: "true()", text: { en: "a" } },
				{ test: "true()", text: { en: "b" } },
			],
		});
		expect(codes(reading)).toContain("case-search/validations-1");
	});
});

describe("Search fields over a table and over dates", () => {
	const TABLE = "01890000-0000-7000-8000-000000000301" as LookupTableId;
	const CODE = "01890000-0000-7000-8000-000000000302" as LookupColumnId;
	const NAME = "01890000-0000-7000-8000-000000000303" as LookupColumnId;
	const REGION = "01890000-0000-7000-8000-000000000304" as LookupColumnId;
	const RANK = "01890000-0000-7000-8000-000000000305" as LookupColumnId;
	const columns = [
		{ id: CODE, wireName: "code", label: "Code", dataType: "text" as const },
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" as const },
		{
			id: REGION,
			wireName: "region",
			label: "Region",
			dataType: "text" as const,
		},
		{ id: RANK, wireName: "rank", label: "Rank", dataType: "int" as const },
	];
	const naming = lookupWireNaming([{ id: TABLE, tag: "districts", columns }]);
	/** The project space's table of districts, as a reading is given it. */
	const withTable = (input: ReaderInput): ReaderInput => ({
		...input,
		lookup: {
			table: (tag) =>
				tag === "districts"
					? {
							tableId: TABLE,
							column: (name) =>
								columns.find((column) => column.wireName === name)?.id,
						}
					: undefined,
			definitions: new Map([
				[TABLE, { id: TABLE, name: "Districts", tag: "districts", columns }],
			]),
		},
	});

	for (const type of ["select", "multi-select"] as const)
		it(`reads a ${type} field whose choices come from a table, sorted and filtered`, async () => {
			const inputs: SearchInputDef[] = [
				{
					uuid: uuid(9),
					// A multiple-choice field matches the property it is named after.
					name: "notes",
					label: "District",
					kind: "simple",
					type,
					property: "notes",
					options: {
						kind: "lookup",
						tableId: TABLE,
						valueColumnId: CODE,
						labelColumnId: NAME,
						sortColumnId: RANK,
						filter: eq(term(tableColumn(TABLE, REGION)), literal("north")),
					},
				},
			];
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
			});
			const reading = await readLists(doc, {
				lookupNaming: naming,
				input: withTable,
			});
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				searchInputs: unknown[];
			};
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
			// The choices' filter is registered under its own slot.
			expect(reading.ctx.pending.list().map((one) => one.ref.slot)).toContain(
				"search_input_options",
			);
		});

	// The emitter prints the label column as the sort of a field with no sort column of its own,
	// so a reading that took the printed sort as the field's own would hold a sort column the
	// document never held.
	it("reads a field ordered by its label column with no sort column of its own", async () => {
		const inputs: SearchInputDef[] = [
			{
				uuid: uuid(9),
				name: "notes",
				label: "District",
				kind: "simple",
				type: "select",
				property: "notes",
				options: {
					kind: "lookup",
					tableId: TABLE,
					valueColumnId: CODE,
					labelColumnId: NAME,
				},
			},
		];
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: inputs,
			search: {},
		});
		const reading = await readLists(doc, {
			lookupNaming: naming,
			input: withTable,
		});
		const prompt = reading.app.modules[0]?.search_config.properties as {
			itemset: { sort: string };
		}[];
		expect(prompt[0]?.itemset.sort).toBe("name");
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			searchInputs: unknown[];
		};
		expect(read.searchInputs).toEqual(asRead(inputs, reading));
	});

	// Every print reads a simple field's mode through its widget's default, so naming exact
	// matching and naming no mode print one source, and the reader returns no mode.
	for (const type of [
		"text",
		"barcode",
		"date",
		"select",
		"multi-select",
	] as const)
		it(`reads a ${type} field that names exact matching as naming no mode`, async () => {
			const property = type === "date" ? "dob" : "notes";
			const base = {
				uuid: uuid(9),
				name: property,
				label: "Field",
				kind: "simple" as const,
				property,
			};
			const field = (exact: boolean): SearchInputDef =>
				type === "select" || type === "multi-select"
					? {
							...base,
							type,
							options: {
								kind: "lookup",
								tableId: TABLE,
								valueColumnId: CODE,
								labelColumnId: NAME,
							},
							...(exact && { mode: { kind: "exact" as const } }),
						}
					: {
							...base,
							type,
							...(exact && { mode: { kind: "exact" as const } }),
						};
			const listed = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [field(true)],
				search: {},
			});
			// A date field searches a property typed a date.
			const named: BlueprintDoc =
				type === "date"
					? {
							...listed,
							caseTypes: [
								{
									name: "patient",
									properties: [
										{
											name: "dob",
											label: proseText("Born"),
											data_type: "date",
										},
									],
								},
							],
						}
					: listed;
			const none = produce(named, (draft) => {
				for (const module of Object.values(draft.modules))
					module.caseListConfig?.searchInputs.splice(0, 1, field(false));
			});
			const exported = (doc: BlueprintDoc) =>
				JSON.stringify(expandDoc(doc, { lookupNaming: naming }));
			expect(exported(named)).toBe(exported(none));
			const chosen = exactSearchModeIsAbsent(named);
			expect(
				chosen.modules[chosen.moduleOrder[0] ?? ""]?.caseListConfig
					?.searchInputs,
			).toEqual([field(false)]);
			expect(exactSearchModeIsAbsent(chosen)).toBe(chosen);
			expect(exactSearchModeIsAbsent(none)).toBe(none);
			const reading = await readLists(named, {
				lookupNaming: naming,
				input: withTable,
			});
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				searchInputs: unknown[];
			};
			expect(read.searchInputs).toEqual(asRead([field(false)], reading));
		});

	for (const dataType of ["date", "datetime"] as const)
		it(`reads a date field over a property only the catalog types ${dataType}`, async () => {
			const inputs: SearchInputDef[] = [
				{
					uuid: uuid(9),
					name: "due",
					label: "Due",
					kind: "simple",
					type: "date",
					property: "due",
				},
			];
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
			});
			const typed: BlueprintDoc = {
				...doc,
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "due",
								label: proseText("Due"),
								data_type: dataType,
							},
						],
					},
				],
			};
			const reading = await readLists(typed);
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				searchInputs: unknown[];
			};
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
		});
});

describe("a Search field's test that reads an answer without Nova's guard on its rows", () => {
	// CommCare HQ's page keeps any test an author types, so a test may read
	// `instance('search-input:results')/input/field[@name = '…']` bare where Nova prints it inside
	// `if(count(…/input/field) > 0, …, '')`, at every read or at some. The reading compares it with
	// the print that leaves that rewrite out (`emissionRewrites.ts`, `empty-rows-guard`) at every
	// site, or at the sites the source leaves it out (`expressions/index.ts::siteLevel`), and the
	// whole search is settled with each slot printed at the level it was held at
	// (`settings.ts::heldSearchLevels`), so the field is held and the rewrite recorded, a worker
	// then seeing a blank answer where there are no rows. The failures it catches: a Search field's
	// slots printed without the reader's rewrite control, so a bare read is left unrecognized at
	// both levels and ends in `expression-not-written-back`; a test spelling the rewrite at one
	// read and not at another, which no whole level prints; and a settle that compares the stored
	// search with the print that applies every rewrite, refusing what the slot held.
	const rows = "instance('search-input:results')/input/field";
	const answer = (name: string) => `${rows}[@name = '${name}']`;
	const guarded = (name: string) =>
		`if(count(${rows}) > 0, ${answer(name)}, '')`;
	const cases: readonly {
		readonly title: string;
		readonly edit: (props: Record<string, unknown>[]) => void;
	}[] = [
		{
			title: "a validation",
			edit: (props) => {
				const one = props[0] as Record<string, unknown>;
				one.validations = [
					{
						test: `${answer(String(one.name))} != 'x'`,
						text: { es: "No x", en: "Not x" },
					},
				];
			},
		},
		{
			title: "a required condition",
			edit: (props) => {
				const one = props[1] as { required: Record<string, unknown> };
				one.required.test = `${answer("case_name")} = ''`;
			},
		},
		{
			title:
				"a validation that reads one answer inside the guard and another bare",
			edit: (props) => {
				const one = props[0] as Record<string, unknown>;
				one.validations = [
					{
						test: `${guarded("case_name")} != 'x' and ${answer("phone")} != 'y'`,
						text: { es: "No x", en: "Not x" },
					},
				];
			},
		},
	];
	for (const one of cases)
		it(`in ${one.title} is held, with the rewrite recorded and no defect`, async () => {
			const body = exportedBody(localizationWireFixture("prompts"));
			const modules = body.modules as {
				search_config: { properties: Record<string, unknown>[] };
			}[];
			one.edit(modules[0]?.search_config.properties ?? []);
			const outcome = readHqApp(await inputFor(body));
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((finding) => finding.code)
					: [],
			).toEqual([]);
			if (outcome.kind !== "read") return;
			expect(
				outcome.draft.facts.rewrites.map((rewrite) => [
					rewrite.id,
					rewrite.key,
					rewrite.place.kind,
				]),
			).toEqual([["empty-rows-guard", "schema:Assertion.test", "search"]]);
		});

	// The control: the same test spelled as Nova prints it is held exact, with no rewrite.
	it("spelled inside the guard at every read is held with no rewrite", async () => {
		const body = exportedBody(localizationWireFixture("prompts"));
		const modules = body.modules as {
			search_config: { properties: Record<string, unknown>[] };
		}[];
		const first = modules[0]?.search_config.properties[0] as Record<
			string,
			unknown
		>;
		first.validations = [
			{
				test: `${guarded("case_name")} != 'x' and ${guarded("phone")} != 'y'`,
				text: { es: "No x", en: "Not x" },
			},
		];
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("read");
		if (outcome.kind !== "read") return;
		expect(outcome.draft.facts.rewrites).toEqual([]);
	});

	// A test whose reads are spelled bare at more sites than any fixed number of steps reaches:
	// the site level flips one site a step, each moving the first difference on, so it ends
	// whatever the number of sites. The failure it catches: a search capped at a number of steps,
	// whose slot then ends in `expression-not-written-back`.
	it("bare at seventy reads and inside the guard at one is held, with the rewrite recorded", async () => {
		const body = exportedBody(localizationWireFixture("prompts"));
		const modules = body.modules as {
			search_config: { properties: Record<string, unknown>[] };
		}[];
		const first = modules[0]?.search_config.properties[0] as Record<
			string,
			unknown
		>;
		const bare = Array.from(
			{ length: 70 },
			(_, at) => `${answer("case_name")} != 'x${at}'`,
		);
		first.validations = [
			{
				test: [...bare, `${guarded("phone")} != 'y'`].join(" and "),
				text: { es: "No x", en: "Not x" },
			},
		];
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("read");
		if (outcome.kind !== "read") return;
		expect(
			outcome.draft.facts.rewrites.map((rewrite) => [
				rewrite.id,
				rewrite.key,
				rewrite.place.kind,
			]),
		).toEqual([["empty-rows-guard", "schema:Assertion.test", "search"]]);
	});
});

describe("a stored validation that carries Nova's runtime guard under a message edited in HQ", () => {
	// Nova writes the guard's message after the field's own in every language
	// (`searchPrompts.ts::buildValidation`). A message an author edited in HQ so no language ends
	// with the guard's text tells nothing of the guard, so the check is registered whole and its
	// refusal waits for the settle, which finds the stored test ending with the guard Nova's
	// projection joins to the field (`settings.ts::runtimeGuardEndings`). Nova prints the guard's
	// sentence after the field's message in the source language, so what keeps the field out is
	// the message. The failure it catches: a check whose reads no whole level prints, ending in
	// `expression-not-written-back`; and the field refused as a check outside what Nova types,
	// which blames the guard Nova wrote.
	const edited = (properties: Record<string, unknown>[]) => {
		const status = properties[2] as {
			validations: { text: Record<string, string> }[];
		};
		const validation = status.validations[0];
		if (validation === undefined) throw new Error("No stored validation.");
		validation.text = { es: "algo", en: "Use lowercase." };
	};
	const findingsOf = async (body: Record<string, unknown>) => {
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind).toBe("account");
		return outcome.kind === "account"
			? outcome.findings.map((finding) => [
					finding.code,
					finding.detail?.name,
					finding.place.kind,
				])
			: [];
	};

	it("joined after the field's own rule is unrecognized at the message, with no defect", async () => {
		const body = exportedBody(localizationWireFixture("prompts"));
		const modules = body.modules as {
			search_config: { properties: Record<string, unknown>[] };
		}[];
		edited(modules[0]?.search_config.properties ?? []);
		expect(await findingsOf(body)).toEqual([
			["unrecognized", "schema:Assertion.text", "search"],
		]);
	});

	it("alone is unrecognized at the message, with no defect", async () => {
		const doc = produce(localizationWireFixture("prompts"), (draft) => {
			for (const mod of Object.values(draft.modules))
				for (const one of mod.caseListConfig?.searchInputs ?? [])
					if (one.name === "status" && one.kind !== "hidden")
						delete one.validation;
		});
		const body = exportedBody(doc);
		const modules = body.modules as {
			search_config: { properties: Record<string, unknown>[] };
		}[];
		edited(modules[0]?.search_config.properties ?? []);
		expect(await findingsOf(body)).toEqual([
			["unrecognized", "schema:Assertion.text", "search"],
		]);
	});

	// Every finding a reading can decide is reported in one pass: the message keeps the field out,
	// and so does an authored rule before the guard that Nova cannot hold, so the reading names
	// both, the rule's refusal as it stands when the rule is the whole test. The failure it
	// catches: the message's finding alone, with the rule's own cause dropped with the guard's.
	it("joined after a rule Nova cannot hold names the message and the rule's own refusal", async () => {
		const rule = "instance('casedb')/casedb/case[@case_id = 'a']/name = 'y'";
		const withTest = (test: (stored: string) => string) => {
			const body = exportedBody(localizationWireFixture("prompts"));
			const modules = body.modules as {
				search_config: { properties: Record<string, unknown>[] };
			}[];
			const properties = modules[0]?.search_config.properties ?? [];
			edited(properties);
			const status = properties[2] as { validations: { test: string }[] };
			const validation = status.validations[0];
			if (validation === undefined) throw new Error("No stored validation.");
			validation.test = test(validation.test);
			return body;
		};
		const guarded = withTest((stored) => {
			const read = readFormSyntax(stored);
			const node = read.ok ? read.node : undefined;
			if (node?.kind !== "binary" || node.op !== "and")
				throw new Error("Nova's check is no rule joined with its guard.");
			return `${rule} and ${stored.slice(node.right.from, node.right.to)}`;
		});
		const alone = await findingsOf(withTest(() => rule));
		expect(alone.length).toBeGreaterThan(0);
		expect(alone.map(([, name]) => name)).not.toContain(
			"schema:Assertion.text",
		);
		expect(await findingsOf(guarded)).toEqual(
			expect.arrayContaining([
				["unrecognized", "schema:Assertion.text", "search"],
				...alone,
			]),
		);
		expect((await findingsOf(guarded)).length).toBe(alone.length + 1);
	});

	// The control: a check with no guard of Nova's whose rule is refused keeps its own refusal.
	it("leaves a refused rule that ends with no guard its own refusal", async () => {
		const guarded = (name: string) =>
			`if(count(instance('search-input:results')/input/field) > 0, instance('search-input:results')/input/field[@name = '${name}'], '')`;
		const body = exportedBody(localizationWireFixture("prompts"));
		const modules = body.modules as {
			search_config: { properties: Record<string, unknown>[] };
		}[];
		const first = modules[0]?.search_config.properties[0] as Record<
			string,
			unknown
		>;
		first.validations = [
			{
				test: `${guarded("case_name")} != 'x' and instance('casedb')/casedb/case[@case_id = 'a']/name = 'y'`,
				text: { es: "No x", en: "Not x" },
			},
		];
		const findings = await findingsOf(body);
		expect(findings.map(([, name]) => name)).not.toContain(
			"schema:Assertion.text",
		);
		expect(findings.length).toBeGreaterThan(0);
	});
});
