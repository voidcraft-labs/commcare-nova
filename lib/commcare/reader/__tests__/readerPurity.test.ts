/**
 * The reader is a pure function of its input.
 *
 * Contract: two readings of one input, each with a fresh resolver, give
 * deeply equal outcomes: the same findings in the same order, the same claim
 * log record for record, the same defects, the same work, and, where a
 * document reads, the same draft. Plausible failures: state a module keeps
 * between readings, or an order that follows a `Map`'s insertion history
 * rather than the source.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mintingResolver } from "../identity";
import { readHqApp } from "../index";
import { exportedBody, inputFor, mirrorMenu } from "./novaExport";

/** An outcome as plain data, the claim log's records read out. */
function plain(outcome: ReturnType<typeof readHqApp>): unknown {
	return JSON.parse(
		JSON.stringify({
			...outcome,
			claims: [...outcome.claims.records()],
			counts: outcome.claims.counts,
		}),
	);
}

it("reads one input twice to one outcome", async () => {
	const doc = buildDoc({
		modules: [
			{
				name: "Clients",
				caseType: "client",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "int",
								id: "age",
								label: "Age",
								relevant: "#form/case_name != ''",
							}),
						],
					},
				],
			},
		],
	});
	const body = exportedBody(doc, {
		modules: (modules) => [
			...modules,
			mirrorMenu(String(modules[0]?.unique_id)),
		],
		root: { translations: { en: { en: "English", "modules.m0": "Patients" } } },
	});
	const input = await inputFor(body);
	const once = readHqApp(
		{ ...input, resolver: mintingResolver(input.appId) },
		{ claims: "full" },
	);
	const twice = readHqApp(
		{ ...input, resolver: mintingResolver(input.appId) },
		{ claims: "full" },
	);
	expect(plain(twice)).toEqual(plain(once));
});
