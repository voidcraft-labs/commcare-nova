/**
 * The role catalog stays complete and its pointers stay true.
 *
 * Three failures this prevents: a new `MODEL_ROLES` entry with no anatomy
 * page, a page whose model facts drift from the constant that governs the
 * live call, and a source pointer that names a file or symbol that no longer
 * exists. The last proof is a source sweep by design: the rule being
 * enforced is "every model call site is registered", which is a property of
 * the source tree, not of any runtime value.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "@/lib/models";
import {
	LIFECYCLES,
	MODEL_ROLE_CALL_SITES,
	MODEL_ROLE_NON_CALL_SITES,
	MODEL_ROLE_TO_ANATOMY,
	ROLE_FACTS,
} from "../catalog";
import { ANATOMY_ROLE_IDS, COMPOSITIONS } from "../index";
import type { SourceRef } from "../types";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function sourceExists(ref: SourceRef): { file: boolean; symbol: boolean } {
	const absolute = path.join(REPO_ROOT, ref.file);
	if (!existsSync(absolute)) return { file: false, symbol: false };
	const text = readFileSync(absolute, "utf8");
	return { file: true, symbol: text.includes(ref.symbol) };
}

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === "__tests__")
			continue;
		const absolute = path.join(dir, entry);
		if (statSync(absolute).isDirectory()) {
			yield* sourceFiles(absolute);
			continue;
		}
		if (!/\.tsx?$/.test(entry) || /\.test\./.test(entry)) continue;
		yield absolute;
	}
}

describe("role catalog", () => {
	it("maps every MODEL_ROLES key to a role page with the same model and effort", () => {
		for (const key of Object.keys(
			MODEL_ROLES,
		) as (keyof typeof MODEL_ROLES)[]) {
			const role = MODEL_ROLE_TO_ANATOMY[key];
			expect(role, key).toBeDefined();
			expect(ANATOMY_ROLE_IDS).toContain(role);
			const facts = ROLE_FACTS[role];
			expect(facts.modelId, role).toBe(MODEL_ROLES[key].modelId);
			expect(facts.effort, role).toBe(MODEL_ROLES[key].reasoningEffort);
		}
		for (const facts of Object.values(ROLE_FACTS)) {
			if (facts.modelRole === null) {
				expect(facts.modelId).toBeNull();
				expect(facts.effort).toBeNull();
				continue;
			}
			expect(facts.modelId).toBe(MODEL_ROLES[facts.modelRole].modelId);
			expect(facts.effort).toBe(MODEL_ROLES[facts.modelRole].reasoningEffort);
		}
	});

	it("places every role on at least one lifecycle strip", () => {
		const onMap = new Set(
			LIFECYCLES.flatMap((lifecycle) =>
				lifecycle.steps.flatMap((step) =>
					step.kind === "role" ? [step.role] : [],
				),
			),
		);
		for (const role of ANATOMY_ROLE_IDS)
			expect(onMap.has(role), role).toBe(true);
	});

	it("points every source reference at an existing file that names the symbol", async () => {
		const refs: { owner: string; ref: SourceRef }[] = Object.values(
			ROLE_FACTS,
		).map((facts) => ({ owner: facts.role, ref: facts.source }));
		for (const composition of Object.values(COMPOSITIONS)) {
			for (const spec of composition.moments) {
				refs.push({
					owner: `${composition.role}/${spec.id}`,
					ref: spec.source,
				});
				const moment = await composition.compose(spec.id, {});
				for (const item of moment.items) {
					refs.push({
						owner: `${composition.role}/${spec.id}/${item.id}`,
						ref: item.source,
					});
					if (item.kind === "system") {
						for (const segment of item.segments) {
							refs.push({
								owner: `${composition.role}/${spec.id}/${item.id}/${segment.id}`,
								ref: segment.source,
							});
						}
					}
				}
			}
		}
		const broken = refs
			.map(({ owner, ref }) => ({ owner, ref, found: sourceExists(ref) }))
			.filter(({ found }) => !found.file || !found.symbol)
			.map(
				({ owner, ref, found }) =>
					`${owner}: ${ref.file}::${ref.symbol} (${found.file ? "symbol missing" : "file missing"})`,
			);
		expect(broken).toEqual([]);
	});

	it("registers every MODEL_ROLES call site or non-call consumer under lib/ and app/", () => {
		const referencing: string[] = [];
		for (const dir of ["lib", "app"]) {
			for (const file of sourceFiles(path.join(REPO_ROOT, dir))) {
				if (readFileSync(file, "utf8").includes("MODEL_ROLES.")) {
					referencing.push(path.relative(REPO_ROOT, file));
				}
			}
		}
		const registered = new Set([
			...MODEL_ROLE_CALL_SITES,
			...MODEL_ROLE_NON_CALL_SITES,
		]);
		const unregistered = referencing.filter((file) => !registered.has(file));
		expect(
			unregistered,
			"a file reads MODEL_ROLES without a catalog entry; add it to MODEL_ROLE_CALL_SITES (and a role page) or MODEL_ROLE_NON_CALL_SITES",
		).toEqual([]);
		const stale = [...registered].filter((file) => !referencing.includes(file));
		expect(
			stale,
			"a registered file no longer reads MODEL_ROLES; remove it from the catalog",
		).toEqual([]);
	});
});
