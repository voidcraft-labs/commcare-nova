/**
 * Where a reading of an app CommCare HQ made records its claims of a form's
 * source: each claim at the node whose value it reads, under the surface key
 * the lane names that node by and an entry that names the key, which is where
 * the lane's parity joins the claim log to its own uses
 * (`proof/checks/parity.py::join`, `manifest_usage.py::xform_uses`).
 *
 * Contract, read over retained bases (`proof/hq-apps/<base>/`) through the
 * lane's own first reading (`proof/reader/laneReading.ts::readForLane`): the
 * frame's model, main instance and itext block each under its own key and the
 * XHTML wrappers under none; every output of a text, a markdown copy's and a
 * translation's for a language the app does not hold among them, with its
 * namespace, its value and the uses its value's syntax makes; a secondary
 * instance's source at its `src` and its id under its own key; a Save to
 * Case block, each node in it and each node beside it at the key the lane
 * names it by, with the uses of the emitter's own texts there and no record
 * of a question type HQ's reader never gives; a Connect block likewise; a
 * model iteration's row and the answer data its attributes hold; a top
 * repeat's template; and a generated Hidden Value's data node. Every attribute Core
 * parses as XPath carries the uses its whole value's syntax makes: a reference path (a bind's
 * `nodeset`, a control's `ref`, a setvalue's `ref`, an itemset's `nodeset` and its label's
 * `ref`, a count no slot reads), a value a slot reads only a part of (a model iteration's query
 * inside its `join`, an itemset's filter, a Save to Case row's trim), and the logic written on a
 * node no question holds; a name an axis names is that axis's step and no child step.
 *
 * Plausible failure: a frame element recorded under the model's key, a
 * container claimed whole while each node inside is its own surface key (the
 * lane's use there unclaimed), a claim recorded at an element whose value
 * sits at an attribute, a `mug:` type recorded where HQ's question reader
 * gives none, and an expression of the emitter's own whose uses go
 * unclaimed; a path's grammar unclaimed while the attribute's own key is
 * recorded, and the uses of a slot's part recorded with the rest of the
 * attribute's value left unclaimed.
 */

import { Element, isTag } from "domhandler";
import { describe, expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { type LaneReadInput, readForLane } from "@/proof/reader/laneReading";
import { serializeXml } from "../../serializeXml";
import { parseXml } from "../../xmlParse";

/** A base's reading covers acceptance of the whole app; a starter app is the largest. */
const READING_MS = 180_000;

interface Record {
	readonly artifact: string;
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
}

async function records(
	id: string,
	input: LaneReadInput = laneInputOf(retainedBase(id)),
): Promise<readonly Record[]> {
	const reading = await readForLane(input);
	if (reading.kind !== "read")
		throw new Error(
			`The base ${id} reads as ${reading.kind}, and it comes in.`,
		);
	return reading.claims
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record);
}

/** A place with each element's namespace left out: a form's data elements carry its xmlns. */
function plain(where: string): string {
	let out = "";
	let depth = 0;
	for (const character of where) {
		if (character === "{") depth += 1;
		else if (character === "}") depth -= 1;
		else if (depth === 0) out += character;
	}
	return out;
}

/** The keyed records of one form at `where`, as `key entry` lines, sorted. */
function at(all: readonly Record[], artifact: string, where: string): string[] {
	return all
		.filter(
			(record) =>
				record.artifact === artifact &&
				plain(record.where) === where &&
				record.key !== null,
		)
		.map((record) => `${record.key} ${record.entry}`)
		.sort();
}

/** The keys recorded at `where`. */
function keysAt(
	all: readonly Record[],
	artifact: string,
	where: string,
): string[] {
	return [
		...new Set(
			all
				.filter(
					(record) =>
						record.artifact === artifact && plain(record.where) === where,
				)
				.map((record) => record.key),
		),
	]
		.filter((key): key is string => key !== null)
		.sort();
}

const Q = "questions";
const E = "expressions-and-data";
const MODEL = "/h:html/h:head[1]/model[1]";
const DATA = `${MODEL}/instance[1]/data[1]`;
const ITEXT = `${MODEL}/itext[1]`;

/** The keyed records at `where` whose key is of a grammar family, as `key entry` lines. */
function grammarAt(
	all: readonly Record[],
	artifact: string,
	where: string,
): string[] {
	return at(all, artifact, where).filter(
		(line) =>
			line.startsWith("xpath-") ||
			line.startsWith("jr-fn:") ||
			line.startsWith("instance-scheme:"),
	);
}

const PATHS = `${E}/xpath-location-paths`;
const OPERATORS = `${E}/xpath-operators-and-literals`;
/** The uses of an absolute path of plain names: `/data/q`. */
const PLAIN_PATH = [
	`xpath-axis:AXIS_CHILD ${PATHS}`,
	`xpath-expr:XPathPathExpr ${PATHS}`,
	`xpath-test:TEST_NAME ${PATHS}`,
	`xpath-token:QNAME ${PATHS}`,
	`xpath-token:SLASH ${PATHS}`,
];

describe("an attribute Core parses as XPath", () => {
	it(
		"carries the uses of its whole value: a reference path's, and an itemset's beside its table read",
		async () => {
			const plainBase = await records("hq-plain");
			expect(
				grammarAt(plainBase, "form:0.0", `${MODEL}/bind[1]/@nodeset`),
			).toEqual(PLAIN_PATH);
			expect(
				grammarAt(plainBase, "form:0.0", "/h:html/h:body[1]/input[1]/@ref"),
			).toEqual(PLAIN_PATH);

			const lookups = await records("hq-lookups");
			const itemset = "/h:html/h:body[1]/select1[1]/itemset[1]";
			expect(grammarAt(lookups, "form:0.0", `${itemset}/@nodeset`)).toEqual([
				`instance-scheme:item-list ${E}/item-list-tag-read-through-nova-s-typed-lookup-carriers`,
				`xpath-axis:AXIS_CHILD ${PATHS}`,
				`xpath-expr:XPathPathExpr ${E}/instance-id-current-path-roots`,
				`xpath-expr:XPathStringLiteral ${OPERATORS}`,
				`xpath-test:TEST_NAME ${PATHS}`,
				`xpath-token:LPAREN ${OPERATORS}`,
				`xpath-token:QNAME ${PATHS}`,
				`xpath-token:RPAREN ${OPERATORS}`,
				`xpath-token:SLASH ${PATHS}`,
				`xpath-token:STR ${OPERATORS}`,
			]);
			expect(
				grammarAt(lookups, "form:0.0", `${itemset}/label[1]/@ref`),
			).toEqual([
				`xpath-axis:AXIS_CHILD ${PATHS}`,
				`xpath-expr:XPathPathExpr ${PATHS}`,
				`xpath-test:TEST_NAME ${PATHS}`,
				`xpath-token:QNAME ${PATHS}`,
			]);
			// A filtered itemset: the filter's slot claims its uses, and the rest of the nodeset
			// (the table's read, the predicate's brackets) stands beside them.
			expect(
				keysAt(
					lookups,
					"form:0.0",
					"/h:html/h:body[1]/select1[2]/itemset[1]/@nodeset",
				),
			).toEqual(
				expect.arrayContaining([
					"xpath-token:EQ",
					"xpath-token:LBRACK",
					"xpath-token:LPAREN",
					"xpath-token:RBRACK",
					"xpath-token:STR",
				]),
			);
		},
		READING_MS,
	);

	it(
		"carries them in a translation for a language the app does not hold, where no slot reads the text",
		async () => {
			const { input, at: value } = withUnreferencedText();
			const health = await records("starter-health", input);
			expect(grammarAt(health, "form:0.0", value)).toEqual(PLAIN_PATH);
			expect(keysAt(health, "form:0.0", value)).toContain(
				"xform:model/itext/translation/text/value/output@value",
			);
		},
		READING_MS,
	);
});

/**
 * `starter-health` with one more text in its first form's translation for a language the app
 * does not hold, under an id no slot references, holding an output of a question's path.
 */
function withUnreferencedText(): {
	readonly input: LaneReadInput;
	/** The added output's value, as `plain` spells its place. */
	readonly at: string;
} {
	const input = laneInputOf(retainedBase("starter-health"));
	const body = JSON.parse(input.source.body as string) as {
		modules: { forms: { unique_id: string }[] }[];
		_attachments: { [name: string]: string };
	};
	const name = `${body.modules[0]?.forms[0]?.unique_id}.xml`;
	const document = parseXml(body._attachments[name] as string);
	const find = (
		parent: { readonly children: readonly unknown[] },
		test: (element: Element) => boolean,
	): Element | undefined => {
		for (const child of parent.children as Element[]) {
			if (!isTag(child)) continue;
			if (test(child)) return child;
			const inner = find(child, test);
			if (inner !== undefined) return inner;
		}
		return undefined;
	};
	const translation = find(
		document,
		(element) =>
			element.name === "translation" && element.attribs.lang === "hin",
	);
	if (translation === undefined) throw new Error("No hin translation.");
	const output = new Element("output", { value: "/data/patient_name" });
	const value = new Element("value", {}, [output]);
	const text = new Element("text", { id: "unreferenced" }, [value]);
	output.parent = value;
	value.parent = text;
	text.parent = translation;
	translation.children.push(text);
	body._attachments[name] = serializeXml(document);
	const position = translation.children.filter(
		(child) => isTag(child) && child.name === "text",
	).length;
	return {
		input: {
			...input,
			source: { ...input.source, body: JSON.stringify(body) },
		},
		at: `${ITEXT}/translation[2]/text[${position}]/value[1]/output[1]/@value`,
	};
}

describe("a form's frame and its texts", () => {
	it(
		"stand under the key used at each element, a markdown copy's and another language's outputs with their uses",
		async () => {
			const agriculture = await records("starter-agriculture");
			const form = "form:1.2";
			expect(keysAt(agriculture, form, "/h:html")).toEqual([]);
			expect(keysAt(agriculture, form, "/h:html/h:head[1]")).toEqual([]);
			expect(keysAt(agriculture, form, "/h:html/h:body[1]")).toEqual([]);
			expect(at(agriculture, form, MODEL)).toEqual([
				"jr-control:model application-and-settings/attachments-form-unique-id-xml",
			]);
			expect(at(agriculture, form, `${MODEL}/instance[1]`)).toEqual([
				"xform:model/instance application-and-settings/attachments-form-unique-id-xml",
			]);
			expect(at(agriculture, form, ITEXT)).toEqual([
				"xform:model/itext application-and-settings/attachments-form-unique-id-xml",
			]);
			// A markdown copy's output: the element, its namespace, its value and the instances
			// its value reads, as the source language's twin is claimed.
			const copy = `${ITEXT}/translation[1]/text[4]/value[2]/output[1]`;
			expect(at(agriculture, form, copy)).toEqual([
				`xform:model/itext/translation/text/value/output ${Q}/output-value-of-a-question-case-or-user-reference`,
			]);
			expect(at(agriculture, form, `${copy}/namespace()`)).toEqual([
				`xform:model/itext/translation/text/value/*@xmlns ${Q}/output-value-of-a-question-case-or-user-reference`,
			]);
			expect(keysAt(agriculture, form, `${copy}/@value`)).toEqual(
				expect.arrayContaining([
					"instance-scheme:casedb",
					"instance-scheme:commcaresession",
					"xform:model/itext/translation/text/value/output@value",
				]),
			);

			const health = await records("starter-health");
			const other = `${ITEXT}/translation[2]`;
			const dropped = `${Q}/translation-for-a-language-not-in-langs`;
			expect(at(health, "form:0.0", other)).toEqual([
				`xform:model/itext/translation ${dropped}`,
			]);
			expect(at(health, "form:0.0", `${other}/text[1]`)).toEqual([
				`xform:model/itext/translation/text ${dropped}`,
			]);
			expect(at(health, "form:0.0", `${other}/text[1]/value[1]`)).toEqual([
				`xform:model/itext/translation/text/value ${dropped}`,
			]);
			const output = `${other}/text[6]/value[1]/output[1]`;
			expect(keysAt(health, "form:0.0", `${output}/namespace()`)).toEqual([
				"xform:model/itext/translation/text/value/*@xmlns",
			]);
			expect(keysAt(health, "form:0.0", `${output}/@value`)).toEqual(
				expect.arrayContaining([
					"xform:model/itext/translation/text/value/output@value",
				]),
			);
		},
		READING_MS,
	);
});

describe("a form's secondary instances", () => {
	it(
		"stand at the source and the id, the element the frame's",
		async () => {
			const plainBase = await records("hq-plain");
			const declaration = `${MODEL}/instance[2]`;
			expect(at(plainBase, "form:0.1", declaration)).toEqual([
				"xform:model/instance application-and-settings/attachments-form-unique-id-xml",
			]);
			expect(at(plainBase, "form:0.1", `${declaration}/@id`)).toEqual([
				`xform:model/instance@id ${E}/casedb-jr-instance-casedb`,
			]);
			expect(at(plainBase, "form:0.1", `${declaration}/@src`)).toEqual([
				`instance-source:casedb ${E}/casedb-jr-instance-casedb`,
			]);
		},
		READING_MS,
	);
});

/**
 * `hq-lookups` with two declarations no expression reads put after its form's last, the tables
 * its choice lists read: Core initializes every declared instance when the form opens
 * (`FormDef.initialize`), and a fixture whose project space may not serve it (the mobile reports)
 * stops the form opening there (`CommCareInstanceInitializer.loadFixtureRoot`), while the ledger
 * loads nothing that can fail. The plausible failures are a declaration claimed
 * under the class of the one before it (the claims of one key were taken in turn, and a table a
 * choice list reads took none, so each later declaration took its neighbour's), and a fixture the
 * project space may not serve dropped as one it serves, with no first-publish change.
 */
describe("a form's declarations no expression reads", () => {
	it(
		"stand under the class Core's load of each gives them, and a fixture the project space may not serve is a first-publish change",
		async () => {
			const base = retainedBase("hq-lookups");
			const source = JSON.parse(base.source.body as string);
			const name = `${source.modules[0].forms[0].unique_id}.xml`;
			const last =
				'<instance src="jr://fixture/item-list:crop-types" id="item-list:crop-types" />';
			const text: string = source._attachments[name];
			expect(text.split(last)).toHaveLength(2);
			source._attachments[name] = text.replace(
				last,
				`${last}<instance id="commcare:reports" src="jr://fixture/commcare:reports"/>` +
					'<instance id="ledger" src="jr://instance/ledgerdb"/>',
			);
			const input = laneInputOf({
				...base,
				source: { ...base.source, body: JSON.stringify(source) },
			});
			const reading = await readForLane(input);
			if (reading.kind !== "read")
				throw new Error(`The base reads as ${reading.kind}.`);
			const all = reading.claims
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as Record);
			const mayNot = `${E}/declared-unreferenced-fixture-instance-the-project-space-may-not`;
			const noData = `${E}/declared-unreferenced-instance-whose-source-loads-no-data-casedb`;
			const declared = (n: number) => [
				...at(all, "form:0.0", `${MODEL}/instance[${n}]/@id`),
				...at(all, "form:0.0", `${MODEL}/instance[${n}]/@src`),
			];
			expect(declared(6)).toEqual([
				`xform:model/instance@id ${mayNot}`,
				`instance-source:fixture ${mayNot}`,
			]);
			expect(declared(7)).toEqual([
				`xform:model/instance@id ${noData}`,
				`instance-source:ledgerdb ${noData}`,
			]);
			expect(declared(2)).toEqual([
				`xform:model/instance@id ${E}/declared-unreferenced-fixture-instance-item-list-locations-user`,
				`instance-source:fixture ${E}/declared-unreferenced-fixture-instance-item-list-locations-user`,
			]);
			expect(reading.firstPublish).toContain(
				"unread-fixture-declarations-dropped",
			);
		},
		READING_MS,
	);
});

describe("a form's Save to Case region", () => {
	it(
		"stands at each node under the key the lane names it by, with the uses of the emitter's own texts",
		async () => {
			const all = await records("hq-nova-then-builder");
			expect(all.filter((record) => record.key === "mug:SaveToCase")).toEqual(
				[],
			);
			const create = `${Q}/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`;
			const block = `${DATA}/nova_operations[1]/first_visit[1]`;
			expect(at(all, "form:0.0", block)).toEqual([
				`xform:model/instance//* ${create}`,
			]);
			expect(
				at(all, "form:0.0", `${block}/case[1]/create[1]/case_type[1]`),
			).toEqual([
				`mug:DataBindOnly ${create}`,
				`xform:model/instance//* ${create}`,
			]);
			expect(at(all, "form:0.0", `${block}/case[1]/namespace()`)).toEqual([
				`xform:model/instance//*@xmlns ${create}`,
			]);
			// A block's case's own attributes, which HQ's question reader reads as Hidden Values.
			expect(
				keysAt(
					all,
					"form:0.0",
					`${DATA}/nova_operations[1]/household[1]/case[1]/@case_id`,
				),
			).toEqual(["mug:DataBindOnly"]);
			// The block's case id, which the emitter writes: its bind and the uses its value makes.
			const caseId = `${MODEL}/bind[5]`;
			expect(at(all, "form:0.0", caseId)).toEqual([
				`xform:model/bind ${Q}/savetocase-update-case-id-xpath`,
			]);
			expect(keysAt(all, "form:0.0", `${caseId}/@calculate`)).toEqual(
				expect.arrayContaining([
					"instance-scheme:commcaresession",
					"xform:model/bind@calculate",
				]),
			);
			// A several-case form: the selected cases' ids, set when the form opens, and the
			// repeat's answer data, which no surface item holds.
			expect(keysAt(all, "form:1.0", `${MODEL}/setvalue[1]/@value`)).toEqual(
				expect.arrayContaining([
					"instance-scheme:selected_cases",
					"xform:setvalue@value",
				]),
			);
			expect(
				keysAt(all, "form:1.0", `${DATA}/nova_selected_cases[1]/@ids`),
			).toEqual([]);
			expect(
				keysAt(all, "form:1.0", `${DATA}/nova_selected_cases[1]/item[1]`),
			).toEqual(["mug:Repeat", "xform:model/instance//*"]);
			expect(keysAt(all, "form:1.0", "/h:html/h:body[1]/group[1]")).toEqual([
				"jr-control:group",
				"xform:group",
			]);
			expect(keysAt(all, "form:1.0", `${MODEL}/setvalue[3]/@event`)).toEqual([
				"jr-event:jr-insert",
				"xform:setvalue@event",
			]);
			// A row's value the slot reads inside the emitter's trim: the trim's uses beside it.
			expect(grammarAt(all, "form:0.0", `${MODEL}/bind[7]/@calculate`)).toEqual(
				expect.arrayContaining([
					`jr-fn:replace ${E}/replace`,
					`xpath-token:COMMA ${OPERATORS}`,
					`xpath-token:STR ${OPERATORS}`,
				]),
			);
			// `current()/../../@case_id`: two parent steps and an attribute step, no child step.
			const caseIdOf = grammarAt(
				all,
				"form:1.0",
				`${MODEL}/bind[8]/@calculate`,
			);
			expect(caseIdOf).toEqual(
				expect.arrayContaining([
					`xpath-axis:AXIS_ATTRIBUTE ${PATHS}`,
					`xpath-axis:AXIS_PARENT ${E}/relative-paths-q-current-x`,
				]),
			);
			expect(caseIdOf.filter((line) => line.includes("AXIS_CHILD"))).toEqual(
				[],
			);
		},
		READING_MS,
	);
});

describe("a form's other blocks and repeats", () => {
	it(
		"stand where the lane reads each: a Connect block, a model iteration's row, a top repeat's template, a generated Hidden Value",
		async () => {
			const deliver = await records("hq-connect-deliver");
			expect(
				deliver.filter((record) => record.key?.startsWith("mug:Connect")),
			).toEqual([]);
			const unit = `${DATA}/visit_unit[1]`;
			expect(at(deliver, "form:0.0", unit)).toEqual([
				`xform:model/instance/*/* ${Q}/connect-deliver-unit`,
			]);
			expect(
				at(deliver, "form:0.0", `${unit}/deliver[1]/entity_id[1]`),
			).toEqual([
				`mug:DataBindOnly ${Q}/connect-deliver-unit`,
				`xform:model/instance//* ${Q}/connect-deliver-unit`,
			]);

			const questions = await records("hq-questions");
			const iteration = `${Q}/repeat-model-iteration-vellum-role-repeat-ids-count-current`;
			expect(at(questions, "form:0.0", `${DATA}/rounds[1]/item[1]`)).toEqual([
				`mug:Repeat ${iteration}`,
				`xform:model/instance//* ${iteration}`,
			]);
			expect(keysAt(questions, "form:0.0", `${DATA}/rounds[1]/@ids`)).toEqual(
				[],
			);
			// The rows' ids: the query the slot reads, inside the `join(' ', …)` the emitter writes.
			expect(
				grammarAt(questions, "form:0.0", `${MODEL}/setvalue[1]/@value`),
			).toEqual(
				expect.arrayContaining([
					`instance-scheme:casedb ${E}/casedb-jr-instance-casedb`,
					`jr-fn:join ${E}/join`,
					`xpath-token:COMMA ${OPERATORS}`,
				]),
			);
			expect(
				grammarAt(questions, "form:0.0", `${MODEL}/setvalue[1]/@ref`),
			).toEqual(
				expect.arrayContaining([
					`xpath-axis:AXIS_ATTRIBUTE ${PATHS}`,
					`xpath-token:AT ${PATHS}`,
				]),
			);
			expect(
				keysAt(questions, "form:0.0", `${DATA}/checks[1]/@jr:template`),
			).toEqual(["xform:model/instance/*/*@jr:template"]);
			// A question's type is the one HQ's question reader gives (`xform.py::VELLUM_TYPE_INDEX`):
			// a signature is an Image, and a Question List whose appearance is `Field-List` a Group,
			// each under the entry the reading holds it by.
			expect(
				at(questions, "form:0.0", `${DATA}/sign[1]`).filter((line) =>
					line.startsWith("mug:"),
				),
			).toEqual([`mug:Image ${Q}/signature-image-signature`]);
			expect(
				at(questions, "form:0.0", `${DATA}/details[1]`).filter((line) =>
					line.startsWith("mug:"),
				),
			).toEqual([
				`mug:FieldList ${Q}/question-list-group-appearance-field-list-labelled`,
			]);
			expect(
				at(questions, "form:0.1", `${DATA}/contact[1]`).filter((line) =>
					line.startsWith("mug:"),
				),
			).toEqual([
				`mug:Group ${Q}/question-list-group-appearance-field-list-labelled`,
			]);

			const management = await records("hq-case-management");
			expect(
				keysAt(management, "form:0.3", `${DATA}/nova_datetime_seen_at[1]`),
			).toEqual(["mug:DataBindOnly", "xform:model/instance/*/*"]);
			// A generated node's `relevant`, which no slot holds.
			expect(
				grammarAt(management, "form:0.3", `${MODEL}/bind[2]/@relevant`),
			).toEqual(
				expect.arrayContaining([
					`jr-fn:count ${E}/count`,
					`xpath-token:GT ${OPERATORS}`,
				]),
			);
		},
		READING_MS,
	);
});
