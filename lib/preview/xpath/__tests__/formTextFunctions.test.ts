import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../evaluator";
import { createInProcessXPathWorkerFactory } from "../inProcessWorkerClient";
import type { EvalContext, XPathFormText } from "../types";
import { XPathRuntime } from "../workerClient";
import type { XPathRuntimeRequest } from "../workerProtocol";

/**
 * `jr:itext` and `jr:choice-name` against the handlers Core installs on a
 * form's evaluation context (`org/javarosa/core/model/FormDef.java::initEvalContext`):
 * the localizer's text or `[itext:<id>]`; for a choice, exact equality with
 * a written choice's value, `''` when nothing matches or the path is not a
 * select, and a failure for a select whose choices come from a table or cases,
 * which Core holds no written choices for.
 */

const formText: XPathFormText = {
	itext: {
		"color-label": "Favourite colour",
		"color-opt0-label": "Red",
		"color-opt1-label": "Blue",
		"media-label": "",
	},
	selects: {
		"/data/color": [
			["red", "Red"],
			["blue", "Blue"],
		],
		"/data/region": null,
	},
};

function context(
	text: XPathFormText | null = formText,
	values: Readonly<Record<string, string>> = {},
): EvalContext {
	return {
		...(text === null ? {} : { formText: text }),
		contextPath: "/data",
		position: undefined,
		getValue: (path) => values[path],
	};
}

describe("jr:itext", () => {
	it("returns the form's text for the id in the form's language", () => {
		expect(evaluate("jr:itext('color-label')", context())).toBe(
			"Favourite colour",
		);
	});

	it("returns an entry with no text as blank, not as missing", () => {
		expect(evaluate("jr:itext('media-label')", context())).toBe("");
	});

	it("returns [itext:<id>] for an id the form has no entry for", () => {
		expect(evaluate("jr:itext('nowhere-label')", context())).toBe(
			"[itext:nowhere-label]",
		);
	});

	it("reads an entry named like an object property as missing", () => {
		expect(evaluate("jr:itext('constructor')", context())).toBe(
			"[itext:constructor]",
		);
	});

	it("does not exist outside a form", () => {
		expect(() => evaluate("jr:itext('color-label')", context(null))).toThrow(
			"Unsupported XPath function in Preview: jr:itext()",
		);
	});
});

describe("jr:choice-name", () => {
	it("returns the label of the written choice whose value matches exactly", () => {
		expect(evaluate("jr:choice-name('blue', '/data/color')", context())).toBe(
			"Blue",
		);
		expect(
			evaluate(
				"jr:choice-name(/data/answer, '/data/color')",
				context(formText, { "/data/answer": "red" }),
			),
		).toBe("Red");
	});

	it("matches nothing for a several-choice answer's whole value", () => {
		expect(
			evaluate("jr:choice-name('red blue', '/data/color')", context()),
		).toBe("");
	});

	it("matches nothing for a near value", () => {
		expect(evaluate("jr:choice-name('Red', '/data/color')", context())).toBe(
			"",
		);
		expect(evaluate("jr:choice-name(' red', '/data/color')", context())).toBe(
			"",
		);
	});

	it("returns blank for a path that names no select question", () => {
		expect(evaluate("jr:choice-name('red', '/data/name')", context())).toBe("");
	});

	it("fails for a select whose choices come from a table or cases", () => {
		expect(() =>
			evaluate("jr:choice-name('north', '/data/region')", context()),
		).toThrow("error in evaluation of xpath function [choice-name]");
	});
});

describe("the form's text in the XPath worker", () => {
	const runtimes: XPathRuntime[] = [];
	afterEach(() => {
		for (const runtime of runtimes.splice(0)) runtime.dispose();
	});

	const request = (
		source: string,
		instances: Partial<XPathRuntimeRequest["instances"]>,
	): XPathRuntimeRequest => ({
		dayNumberEpoch: "device-zone",
		entryKey: "entry-text",
		revision: 1,
		profile: "form",
		source,
		instances: { contextPath: "/data", ...instances },
	});

	it("keeps the text with the world and takes a newer one when it changes", async () => {
		const runtime = new XPathRuntime({
			workerFactory: createInProcessXPathWorkerFactory(),
		});
		runtimes.push(runtime);
		await expect(
			runtime.request(
				request("jr:itext('color-label')", {
					worldKey: "text-world",
					initializeWorld: true,
					formText,
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "Favourite colour" });
		// A later request in the same world carries no text and reads the
		// world's.
		await expect(
			runtime.request(
				request("jr:choice-name('blue', '/data/color')", {
					worldKey: "text-world",
					initializeWorld: false,
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "Blue" });
		await expect(
			runtime.request(
				request("jr:itext('color-label')", {
					worldKey: "text-world",
					initializeWorld: false,
					formText: {
						...formText,
						itext: { ...formText.itext, "color-label": "Couleur" },
					},
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "Couleur" });
		await expect(
			runtime.request(
				request("jr:itext('color-label')", {
					worldKey: "text-world",
					initializeWorld: false,
				}),
			),
		).resolves.toMatchObject({ ok: true, value: "Couleur" });
	});
});
