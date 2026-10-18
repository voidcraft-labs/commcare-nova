/**
 * The cutover must recover exactly the text the old document projects before
 * the new parser lifts it. A copied printer that misses one leaf or resolves
 * an identity against a different parent would silently lift another
 * expression. Compare every frozen fixture's old AST with the production
 * printer, using raw carriers on the frozen side and hydrated topology on
 * the production side. This comparison leaves with the old schema in PR5.
 *
 * The raw-reference cases also hold the defensive boundary: unresolved or
 * cyclic identities produce a failed projection, never plausible text that
 * the lift could accept. They need no database or emitter.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assemblePersistedBlueprintJsonText,
	type PersistedBlueprintRootText,
	type PersistedEntityRowText,
} from "@/lib/db/persistedJson";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	isXPathExpression,
	projectXPath,
	type XPathExpression,
	xpathPrintContext,
} from "@/lib/domain/xpath";
import {
	type FrozenXPathExpression,
	type FrozenXPathPrintableDoc,
	frozenXPathPrintContext,
	projectFrozenXPath,
} from "../frozenPrinter";

const PRE_STEP = join(import.meta.dirname, "fixtures", "pre-step");

function expressions(
	value: unknown,
	path = "",
): readonly { path: string; expression: XPathExpression }[] {
	if (isXPathExpression(value)) return [{ path, expression: value }];
	if (value === null || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) =>
		expressions(child, `${path}/${key}`),
	);
}

describe("the frozen pre-step printer", () => {
	it("matches production over every frozen fixture's expressions", () => {
		const manifest = JSON.parse(
			readFileSync(join(PRE_STEP, "manifest.json"), "utf8"),
		) as { fixtures: readonly { id: string }[] };
		expect(manifest.fixtures.length).toBeGreaterThan(0);
		let compared = 0;
		for (const { id } of manifest.fixtures) {
			const carriers = JSON.parse(
				readFileSync(join(PRE_STEP, id, "carriers.json"), "utf8"),
			) as {
				root: PersistedBlueprintRootText;
				rows: readonly PersistedEntityRowText[];
			};
			const raw = assemblePersistedBlueprintJsonText(
				id,
				carriers.root,
				carriers.rows,
			);
			const frozen = frozenXPathPrintContext(raw);
			const production = xpathPrintContext(hydratePersistedBlueprint(raw));
			for (const { path, expression } of expressions(raw)) {
				expect(projectFrozenXPath(expression, frozen), `${id}${path}`).toEqual(
					projectXPath(expression, production),
				);
				compared++;
			}
		}
		expect(compared).toBeGreaterThan(0);
	});

	it("prints all seven old part kinds from raw names and order arrays, keeping text verbatim", () => {
		const doc: FrozenXPathPrintableDoc = {
			fields: { group: { id: "details" }, question: { id: "renamed" } },
			forms: { form: {} },
			fieldOrder: { form: ["group"], group: ["question"] },
			userProperties: { worker: { slug: "region" } },
			modules: {
				module: {
					caseListConfig: {
						searchInputs: [{ uuid: "prompt", name: "search_name" }],
					},
				},
			},
		};
		const expression: FrozenXPathExpression = {
			parts: [
				{ kind: "text", text: "  concat(" },
				{ kind: "field-ref", uuid: "question" },
				{ kind: "text", text: ",  " },
				{ kind: "path-ref", uuid: "question" },
				{ kind: "text", text: ", " },
				{ kind: "case-ref", caseType: "visit", property: "seen" },
				{ kind: "text", text: ", " },
				{ kind: "user-ref", property: "username" },
				{ kind: "text", text: ", " },
				{ kind: "user-property-ref", userPropertyUuid: "worker" },
				{ kind: "text", text: ", " },
				{ kind: "search-answer-ref", searchInputUuid: "prompt" },
				{ kind: "text", text: ")  \n" },
			],
		};
		expect(
			projectFrozenXPath(expression, frozenXPathPrintContext(doc)),
		).toEqual({
			ok: true,
			text: "  concat(#form/details/renamed,  /data/details/renamed, #visit/seen, #user/username, #user/region, #search/search_name)  \n",
		});
	});

	it("reports every missing identity without resolving inherited record members", () => {
		const inherited = Object.create({
			missing: { id: "inherited", slug: "inherited" },
		}) as Record<string, unknown>;
		const context = frozenXPathPrintContext({
			fields: inherited,
			forms: { form: {} },
			fieldOrder: { form: ["missing"] },
			userProperties: inherited,
		});
		expect(
			projectFrozenXPath(
				{
					parts: [
						{ kind: "field-ref", uuid: "missing" },
						{ kind: "text", text: " | " },
						{ kind: "path-ref", uuid: "missing" },
						{ kind: "text", text: " | " },
						{ kind: "user-property-ref", userPropertyUuid: "missing" },
						{ kind: "text", text: " | " },
						{ kind: "search-answer-ref", searchInputUuid: "missing" },
					],
				},
				context,
			),
		).toEqual({
			ok: false,
			text: "#form/[reference needs repair] | /data/[reference needs repair] | #user/[reference needs repair] | #search/[reference needs repair]",
			unresolved: [
				{ kind: "field-ref", identity: "missing" },
				{ kind: "path-ref", identity: "missing" },
				{ kind: "user-property-ref", identity: "missing" },
				{ kind: "search-answer-ref", identity: "missing" },
			],
		});
	});

	it("refuses to project a field whose parent chain never reaches a form", () => {
		const context = frozenXPathPrintContext({
			fields: { first: { id: "first" }, second: { id: "second" } },
			forms: {},
			fieldOrder: { first: ["second"], second: ["first"] },
		});
		expect(
			projectFrozenXPath(
				{ parts: [{ kind: "field-ref", uuid: "first" }] },
				context,
			),
		).toEqual({
			ok: false,
			text: "#form/[reference needs repair]",
			unresolved: [{ kind: "field-ref", identity: "first" }],
		});
	});

	it("keeps an explicitly missing maintained parent instead of deriving another", () => {
		const context = frozenXPathPrintContext({
			fields: { question: { id: "answer" } },
			forms: { form: {} },
			fieldOrder: { form: ["question"] },
			fieldParent: { question: null },
		});
		expect(
			projectFrozenXPath(
				{ parts: [{ kind: "path-ref", uuid: "question" }] },
				context,
			),
		).toEqual({
			ok: false,
			text: "/data/[reference needs repair]",
			unresolved: [{ kind: "path-ref", identity: "question" }],
		});
	});

	it("keeps the old empty expression empty", () => {
		expect(
			projectFrozenXPath(
				{ parts: [] },
				frozenXPathPrintContext({ fields: {}, forms: {}, fieldOrder: {} }),
			),
		).toEqual({ ok: true, text: "" });
	});
});
