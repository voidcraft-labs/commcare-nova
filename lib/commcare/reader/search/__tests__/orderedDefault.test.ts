import { expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	codes,
	emittedApp,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";

const username = "instance('commcaresession')/session/context/username";
const rawDefault = `if(${username} > 'm', 'north', 'south')`;
const numericDefault = `if(number(${username}) > number('m'), 'north', 'south')`;
const source = patients([plainColumn(uuid(1), "case_name", "Name")], {
	searchInputs: [
		{
			uuid: uuid(9),
			name: "village",
			label: "Village",
			kind: "simple",
			type: "text",
			property: "village",
		},
	],
	search: {},
});

async function readDefault(expression: string) {
	return readLists(source, {
		edit(app) {
			const prompts = app.modules[0]?.search_config.properties as {
				default_value?: string;
			}[];
			prompts[0].default_value = expression;
		},
	});
}

it("keeps the username comparison in a simple text Search starting value", async () => {
	const reading = await readDefault(rawDefault);
	expect(reading.findings).toEqual([]);
	expect(listOf(reading).searchInputs[0]).toMatchObject({
		kind: "simple",
		type: "text",
		default: {
			kind: "if",
			cond: {
				kind: "gt",
				left: {
					kind: "term",
					term: { kind: "session-context", field: "username" },
				},
				right: { kind: "term", term: { kind: "literal", value: "m" } },
			},
		},
	});
	const doc = reading.ctx.doc;
	if (doc === undefined)
		throw new Error("Expected the assembled Search default");
	const app = await emittedApp(doc);
	expect(app.modules[0]?.search_config.properties).toMatchObject([
		{ default_value: rawDefault },
	]);
});

it.each([
	numericDefault,
	`if(${username} < 'm', 'north', 'south')`,
	`if(${username} > '12:00', 'north', 'south')`,
	"if(instance('commcaresession')/session/context/userid > 'm', 'north', 'south')",
])("keeps the existing refusal for %s", async (expression) => {
	const reading = await readDefault(expression);
	expect(codes(reading)).toEqual([
		"case-search/default-value-outside-valueexpression",
	]);
});
