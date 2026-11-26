/**
 * One reading reports every finding of an app in one pass.
 *
 * Contract: an app holding a mirror menu, an appearance Nova can't hold yet,
 * two load-time values in an order a save in HQ's form builder changes, and an
 * expression that parses and the checker refuses (a date ordered against a
 * date and time) reads to one account that names all four,
 * each at its own place: no stage stops the reading early, and a finding of one
 * stage hides none of another's.
 *
 * Plausible failure: a structural finding that skips the expression stage, or
 * an expression finding that skips the form checks after it.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { readHqApp } from "../index";
import { whereText } from "../place";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";

/** The two `<setvalue>` elements of a source, in the opposite order. */
function swapSetvalues(xml: string): string {
	const first = xml.indexOf("<setvalue");
	const second = xml.indexOf("<setvalue", first + 1);
	if (first < 0 || second < 0) throw new Error("The form holds two setvalues.");
	const end = (from: number) => xml.indexOf("/>", from) + 2;
	const a = xml.slice(first, end(first));
	const b = xml.slice(second, end(second));
	return `${xml.slice(0, first)}${b}${xml.slice(end(first), second)}${a}${xml.slice(end(second))}`;
}

it("names every finding of an app in one account", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "single_select",
								id: "choice",
								label: "Choice",
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}),
							f({
								kind: "text",
								id: "early",
								label: "Early",
								default_value: "#form/late",
							}),
							f({
								kind: "text",
								id: "late",
								label: "Late",
								default_value: "'seed'",
							}),
							f({
								kind: "text",
								id: "shown",
								label: "Shown",
								relevant: "#form/early = 'x'",
							}),
						],
					},
				],
			},
		],
	});
	const edit = (xml: string): string => {
		const appearance = xml.replace(
			'<select1 ref="/data/choice"',
			'<select1 appearance="minimal foo" ref="/data/choice"',
		);
		// It parses, and the checker refuses a date ordered against a date and time.
		const refused = appearance.replaceAll(
			"early = &apos;x&apos;",
			"early = &apos;x&apos; and today() &lt; now()",
		);
		expect(refused).not.toBe(appearance);
		expect(appearance).not.toBe(xml);
		return swapSetvalues(refused);
	};
	const input = await inputFor(
		exportedBody(doc, {
			xml: edit,
			modules: (modules) => [
				...modules,
				mirrorMenu(String(modules[0]?.unique_id)),
			],
		}),
	);
	const outcome = readHqApp(input);
	expect(outcome.kind).toBe("account");
	if (outcome.kind !== "account") return;
	const at = (place: string) =>
		outcome.findings.filter((finding) => whereText(finding.place) === place);
	const question = (path: string) =>
		outcome.findings.filter(
			(finding) =>
				finding.place.kind === "question" && finding.place.path === path,
		);
	expect(
		at(whereText({ kind: "menu", menu: 1, name: "" })).length,
	).toBeGreaterThan(0);
	/* A token no runtime reads beside a dropdown, which Nova can't hold. */
	expect(
		question("choice").some((finding) => finding.code.startsWith("questions/")),
	).toBe(true);
	expect(
		question("shown").map((finding) =>
			finding.code.slice(finding.code.indexOf("/") + 1),
		),
	).toContain("a-form-expression-outside-what-nova-types");
	expect(outcome.findings.map((finding) => finding.code)).toContain(
		"questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes",
	);
});
