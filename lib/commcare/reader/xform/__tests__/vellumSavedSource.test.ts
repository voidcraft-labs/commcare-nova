/**
 * R1, a save's own respelling: a Nova export, and the same export after HQ's
 * form builder saved one of its forms with nothing changed
 * (`proof/hq-reads/navigation-base/app-source.json` and
 * `app-source-after-form-builder-save.json`). What a save respells (the
 * order of attributes, added `vellum:` attributes, the hashtag blocks) must
 * not disturb the reading: each form, matched by its `xmlns`, reads to equal
 * fields, kinds, slots, expressions (compared as trees), generated nodes and
 * findings.
 *
 * Plausible failures: a save's respelling read as a difference, or a
 * generated node a save left in place read as a Hidden Value.
 */

import { expect, it } from "vitest";
import type { Finding } from "@/lib/publish/hqFindings";
import {
	closeAfterStructure,
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import { readStructure } from "../../structure";
import { sameXPathText } from "../../syntaxCompare";
import { type DraftField, mintFields, readForms } from "../index";
import { readFields } from "./formReading";

/** A value with every minted identity left out. */
function withoutIdentities(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutIdentities);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "uuid")
			.map(([key, inner]) => [key, withoutIdentities(inner)]),
	);
}

function fieldView(field: DraftField) {
	return {
		path: field.node.path.join("/"),
		kind: field.kind,
		parent: field.parent?.node.path.join("/") ?? null,
		field: withoutIdentities(field.field),
		expressions: field.expressions.map((one) => ({
			slot: one.slot,
			key: one.key,
			event: one.event,
		})),
	};
}

async function readApp(file: string) {
	const ctx = readContext(
		readerInput(await sourceFromBody(retainedSourceBody(file))),
	);
	readApplication(ctx);
	readStructure(ctx);
	readForms(ctx);
	mintFields(ctx);
	const forms = new Map(
		ctx.draft.modules
			.flatMap((module) => module.forms)
			.map((form) => [form.xmlns, form] as const),
	);
	const findings = closeAfterStructure(ctx).findings.filter(
		(finding) =>
			finding.place.kind === "form" || finding.place.kind === "question",
	);
	return { forms, findings };
}

const findingView = (finding: Finding) => ({
	code: finding.code,
	place: finding.place,
	name: finding.detail.name,
});

it("reads a form HQ's form builder saved unchanged to the reading of the form before the save", async () => {
	const before = await readApp("navigation-base/app-source");
	const after = await readApp(
		"navigation-base/app-source-after-form-builder-save",
	);
	expect([...after.forms.keys()].sort()).toEqual(
		[...before.forms.keys()].sort(),
	);
	for (const [xmlns, form] of before.forms) {
		const saved = after.forms.get(xmlns);
		const was = form.xform;
		const now = saved?.xform;
		if (was === null || now === null || now === undefined)
			throw new Error(`The form ${xmlns} did not read.`);
		const wasFields = readFields(was);
		const nowFields = readFields(now);
		expect(nowFields.map(fieldView)).toEqual(wasFields.map(fieldView));
		wasFields.forEach((field, index) => {
			const other = nowFields[index] as DraftField;
			field.expressions.forEach((expression, at) => {
				const text = other.expressions[at]?.text ?? "";
				expect(
					sameXPathText(expression.text, text, { ruleSet: "form" }),
					`${xmlns} ${field.id} ${expression.slot}`,
				).toBe(true);
			});
		});
		expect(now.generated).toEqual(was.generated);
		expect(now.candidates.map((node) => node.name)).toEqual(
			was.candidates.map((node) => node.name),
		);
	}
	expect(after.findings.map(findingView)).toEqual(
		before.findings.map(findingView),
	);
});
