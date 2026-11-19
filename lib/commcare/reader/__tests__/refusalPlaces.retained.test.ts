/**
 * Where a refusal made of a value in a form's source stands in the claim log: at the node whose
 * value makes the refusal's class, under the surface key the lane names that node by, beside
 * whatever claim already holds the node there (`Accounting.findingAtNode`). That is the place the
 * lane's parity decides the class at (`proof/checks/manifest_value_classes.py`), so a variant's
 * use of it finds a record naming the refusal's entry.
 *
 * Contract, read over `hq-questions` with its first form edited as its variants in
 * `proof/matrix/variants/questions.py` edit it: a control's `ref` whose data node sits under
 * another repeat, at the `ref`; a data node holding text, at the data node; a repeat a worker adds
 * rows to inside a question list, at the `<repeat>`; a model iteration inside another repeat, at
 * its node's `vellum:role`; a data root whose `uiVersion` is other than `1`, at the data root and
 * not at the attribute; a data root named other than `data`, at the data root.
 *
 * Plausible failure: a refusal recorded only as a finding, with no site, or at another node than
 * its class's value (the data node for a control's `ref`, the attribute for the data root's own
 * key), so the lane's use there finds only the allowing claim that holds the node.
 */

import { describe, expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { readForLane } from "@/proof/reader/laneReading";

/** A base's reading covers acceptance of the whole app. */
const READING_MS = 180_000;

interface Record {
	readonly artifact: string;
	readonly where: string;
	readonly key: string | null;
	readonly entry: string;
}

const Q = "questions";
const MODEL = "/h:html/h:head[1]/model[1]";

/** `text` with each `[old, new, count]` made in order, `old` held to occur `count` times (every
 *  occurrence replaced), as the variants' `_replaced` makes them. */
function replaced(
	text: string,
	pairs: readonly (readonly [string, string, number])[],
): string {
	let out = text;
	for (const [from, to, count] of pairs) {
		const found = out.split(from).length - 1;
		if (found !== count)
			throw new Error(
				`The form's source holds ${JSON.stringify(from)} ${found} times, not ${count}.`,
			);
		out = out.replaceAll(from, to);
	}
	return out;
}

/** `text` with its part from `start` through `end` moved to just after `after` (`_moved`). */
function moved(
	text: string,
	start: string,
	end: string,
	after: string,
): string {
	const first = text.indexOf(start);
	const last = text.indexOf(end, first) + end.length;
	if (first < 0 || last < end.length)
		throw new Error("The form's source holds no such part.");
	const part = text.slice(first, last);
	return replaced(text.slice(0, first) + text.slice(last), [
		[after, after + part, 1],
	]);
}

/** The claim log of `hq-questions` with its first form's source given to `edit`. */
async function readEdited(
	edit: (text: string) => string,
): Promise<readonly Record[]> {
	const base = retainedBase("hq-questions");
	const source = JSON.parse(base.source.body as string) as {
		modules: { forms: { unique_id: string }[] }[];
		_attachments: { [name: string]: string };
	};
	const form = source.modules[0]?.forms[0];
	if (form === undefined) throw new Error("hq-questions holds no form.");
	const name = `${form.unique_id}.xml`;
	source._attachments[name] = edit(source._attachments[name] as string);
	const reading = await readForLane(
		laneInputOf({
			...base,
			source: { ...base.source, body: JSON.stringify(source) },
		}),
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

/** Each keyed place of form 0.0 the log records `entry` at, as `key where`. */
function placesOf(records: readonly Record[], entry: string): string[] {
	return records
		.filter(
			(one) =>
				one.artifact === "form:0.0" && one.entry === entry && one.key !== null,
		)
		.map((one) => `${one.key} ${plain(one.where)}`)
		.sort();
}

const FULL_NAME_INPUT =
	'<input vellum:ref="#form/full_name" ref="/data/full_name">';
const FULL_NAME_CLOSE =
	"<help ref=\"jr:itext('full_name-help')\" />\n\t\t</input>";
const MEMBER_NAME_CLOSE =
	"ref=\"jr:itext('members/member_name-label')\" />\n\t\t\t\t</input>";
const NICKNAME_CLOSE =
	"ref=\"jr:itext('details/nickname-label')\" />\n\t\t\t</input>";
const CHECKS_COUNT =
	'vellum:jr__count="#form/visits_due" jr:count="/data/visits_due" jr:noAddRemove="true()"';
const CHECKS_OPEN = "<group>\n\t\t\t<label ref=\"jr:itext('checks-label')\" />";
const CHECKS_CLOSE =
	"ref=\"jr:itext('checks/check_note-label')\" />\n\t\t\t\t</input>\n\t\t\t</repeat>\n\t\t</group>";
const ROUNDS_DATA_OPEN =
	'<rounds ids="" count="" current_index="" vellum:role="Repeat">';
const ROUNDS_OPEN = "<group>\n\t\t\t<label ref=\"jr:itext('rounds-label')\" />";
const ROUNDS_CLOSE =
	"ref=\"jr:itext('rounds/item/round_note-label')\" />\n\t\t\t\t</input>\n\t\t\t</repeat>\n\t\t</group>";

describe("a refusal made of a value in a form's source", () => {
	it(
		"stands at a control's ref whose data node sits under another repeat",
		async () => {
			const records = await readEdited((text) =>
				moved(text, FULL_NAME_INPUT, FULL_NAME_CLOSE, MEMBER_NAME_CLOSE),
			);
			expect(placesOf(records, `${Q}/data-parent-crossing-a-repeat`)).toEqual([
				"xform:input@ref /h:html/h:body[1]/group[2]/repeat[1]/input[2]/@ref",
			]);
		},
		READING_MS,
	);

	it(
		"stands at a data node holding text",
		async () => {
			const records = await readEdited((text) =>
				replaced(text, [["<full_name />", "<full_name>Ann</full_name>", 1]]),
			);
			expect(
				placesOf(records, `${Q}/default-data-value-datavalue-instance-text`),
			).toEqual([
				`xform:model/instance/*/* ${MODEL}/instance[1]/data[1]/full_name[1]`,
			]);
		},
		READING_MS,
	);

	it(
		"stands at a repeat a worker adds rows to inside a question list",
		async () => {
			const records = await readEdited((text) => {
				let out = replaced(text, [[`${CHECKS_COUNT} `, "", 1]]);
				out = moved(
					out,
					'<checks jr:template="">',
					"</checks>",
					"<nickname />",
				);
				out = moved(out, CHECKS_OPEN, CHECKS_CLOSE, NICKNAME_CLOSE);
				out = out.replaceAll("/data/checks", "/data/details/checks");
				return out.replaceAll("#form/checks", "#form/details/checks");
			});
			expect(
				placesOf(
					records,
					`${Q}/user-controlled-repeat-inside-a-question-list-a-group-whose`,
				),
			).toEqual(["xform:repeat /h:html/h:body[1]/group[1]/group[1]/repeat[1]"]);
		},
		READING_MS,
	);

	it(
		"stands at the role of a model iteration inside another repeat",
		async () => {
			const records = await readEdited((text) => {
				let out = moved(text, ROUNDS_DATA_OPEN, "</rounds>", "<member_name />");
				out = moved(out, ROUNDS_OPEN, ROUNDS_CLOSE, MEMBER_NAME_CLOSE);
				out = replaced(out, [
					[
						'<setvalue event="xforms-ready" ref="/data/rounds/',
						'<setvalue event="jr-insert" ref="/data/rounds/',
						2,
					],
				]);
				out = out.replaceAll("/data/rounds", "/data/members/rounds");
				return out.replaceAll("#form/rounds", "#form/members/rounds");
			});
			expect(
				placesOf(
					records,
					`${Q}/model-iteration-repeat-nested-in-another-repeat-of-any-kind`,
				),
			).toEqual([
				`vellum-markup:model/instance//*@vellum:role ${MODEL}/instance[1]/data[1]/members[1]/rounds[1]/@vellum:role`,
			]);
		},
		READING_MS,
	);

	it(
		"stands at the data root whose uiVersion is other than 1, and not at the attribute",
		async () => {
			const records = await readEdited((text) =>
				replaced(text, [['uiVersion="1"', 'uiVersion="2"', 1]]),
			);
			expect(
				placesOf(records, `${Q}/data-root-uiversion-other-than-1-or-absent`),
			).toEqual([`xform:model/instance/* ${MODEL}/instance[1]/data[1]`]);
		},
		READING_MS,
	);

	it(
		"stands at a data root named other than data",
		async () => {
			const records = await readEdited((text) =>
				replaced(text, [
					["<data xmlns:jrm=", "<survey xmlns:jrm=", 1],
					["</data>", "</survey>", 1],
				]).replaceAll("/data/", "/survey/"),
			);
			expect(
				placesOf(records, `${Q}/data-root-element-named-other-than-data`),
			).toContain(`xform:model/instance/* ${MODEL}/instance[1]/survey[1]`);
		},
		READING_MS,
	);
});
