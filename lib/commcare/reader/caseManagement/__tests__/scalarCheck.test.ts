/**
 * Nova's scalar check on the question that names a case or gives its
 * external id, folded out of the question's constraint and held.
 *
 * Contract: the forms stage folds the check Nova's emitter conjoins onto such
 * a question's `constraint` (`xform/builder.ts::questionScalarCheck`) and
 * records which of the two it was; the case management stage keeps the fold
 * only where the emitter would write the same check back
 * (`caseScalarTextGuards` of the read document), and raises `unrecognized` at
 * the question with `xform:model/bind@constraint` where it would not. The
 * plausible failure: a check folded out and not written back, which drops a
 * validation at the first publish, or a check read as the author's own
 * validation, which the emitter then writes twice.
 */
import type { Element } from "domhandler";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { serializeXml } from "../../../serializeXml";
import { questionScalarCheck } from "../../../xform/builder";
import { parseXml } from "../../../xmlParse";
import { serializeWire } from "../../../xpath/wire/serialize";
import {
	type AppJson,
	type JsonObject,
	readMenusOf,
} from "../../menus/__tests__/menuReading";
import { foldScalarCheck } from "../../xform/logic";
import { readCases, readFields } from "./caseReading";

function registration(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "code",
								caseWrite: { caseType: "patient", property: "external_id" },
							}),
							f({ kind: "text", id: "other", validate: ". != 'x'" }),
						],
					},
				],
			},
		],
	});
}

/** The registration form's source in `app`, changed by `change` through the production parser and
 *  serializer. */
function editForm(app: AppJson, change: (binds: Element[]) => void): void {
	const form = app.modules[0]?.forms[0] as JsonObject;
	const attachments = app._attachments as Record<string, string>;
	const key = `${form.unique_id as string}.xml`;
	const source = attachments[key];
	if (source === undefined)
		throw new Error("The app holds the registration's source.");
	const document = parseXml(source);
	const binds: Element[] = [];
	const walk = (node: { children?: unknown[] }) => {
		for (const child of (node.children ?? []) as Element[]) {
			if (child.type === "tag" && child.name === "bind") binds.push(child);
			walk(child as { children?: unknown[] });
		}
	};
	walk(document as { children?: unknown[] });
	change(binds);
	attachments[key] = serializeXml(document);
}

function bindOf(binds: Element[], path: string): Element {
	const bind = binds.find((one) => one.attribs.nodeset === path);
	if (bind === undefined)
		throw new Error(`The source holds no bind for ${path}.`);
	return bind;
}

function unrecognizedConstraints(
	findings: readonly { code: string; detail: unknown; place: unknown }[],
) {
	return findings
		.filter(
			(one) =>
				one.code === "unrecognized" &&
				(one.detail as { name?: string }).name ===
					"xform:model/bind@constraint",
		)
		.map((one) => (one.place as { path?: string }).path);
}

describe("Nova's scalar check on a question that names a case", () => {
	it("reads a registration Nova emitted with no unrecognized finding", async () => {
		const reading = await readMenusOf(registration());
		expect(
			reading.findings.filter((one) => one.code === "unrecognized"),
		).toEqual([]);
		expect(reading.outcome.kind).toBe("read");
		const fields = Object.values(reading.doc?.fields ?? {});
		expect(fields.find((one) => one.id === "name")).not.toHaveProperty(
			"validate",
		);
		expect(fields.find((one) => one.id === "other")).toHaveProperty("validate");
	});

	it("records which check each question carried, and folds the author's validation out beside it", async () => {
		const { forms } = await readCases(registration());
		const xform = forms[0]?.xform;
		if (xform == null) throw new Error("The registration is read.");
		const byId = new Map(readFields(xform).map((one) => [one.id, one]));
		expect(byId.get("name")?.scalarCheck).toBe("reject");
		expect(byId.get("code")?.scalarCheck).toBe("allow");
		expect(byId.get("other")?.scalarCheck).toBeUndefined();
		expect(
			byId.get("name")?.expressions.some((one) => one.slot === "validate"),
		).toBe(false);
		const print = (check: "reject" | "allow") =>
			serializeWire(questionScalarCheck(check), {
				target: "xform",
				constraint: true,
			}).text;
		expect(foldScalarCheck(`. != 'x' and ${print("allow")}`)).toEqual({
			check: "allow",
			authored: ". != 'x'",
		});
		expect(foldScalarCheck(print("reject"))).toEqual({
			check: "reject",
			authored: undefined,
		});
		expect(foldScalarCheck(". != 'x'")).toBeUndefined();
	});

	it("raises unrecognized at the question where the name action names another question", async () => {
		const reading = await readMenusOf(registration(), (app) => {
			const form = app.modules[0]?.forms[0] as JsonObject;
			const open = (form.actions as JsonObject).open_case as JsonObject;
			open.name_update = {
				question_path: "/data/other",
				update_mode: "always",
			};
		});
		expect(unrecognizedConstraints(reading.findings)).toContain("name");
	});

	it("raises unrecognized at the question where its check is the external id's", async () => {
		const allow = serializeWire(questionScalarCheck("allow"), {
			target: "xform",
			constraint: true,
		}).text;
		const reading = await readMenusOf(registration(), (app) =>
			editForm(app, (binds) => {
				bindOf(binds, "/data/name").attribs.constraint = allow;
			}),
		);
		expect(unrecognizedConstraints(reading.findings)).toContain("name");
	});

	it("never records a check on a Hidden Value that names the case", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "hidden",
									id: "name",
									calculate: {
										kind: "term",
										term: { kind: "literal", value: "x" },
									},
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
		});
		const { forms } = await readCases(doc);
		const xform = forms[0]?.xform;
		if (xform == null) throw new Error("The registration is read.");
		expect(readFields(xform).map((one) => one.scalarCheck)).toEqual([
			undefined,
		]);
	});
});
