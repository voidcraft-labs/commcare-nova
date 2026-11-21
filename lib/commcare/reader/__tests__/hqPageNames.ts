/**
 * The rule a finding's `detail.name` keeps: it holds only words a person knows
 * from CommCare HQ's pages, never a surface key, a column HQ named for itself
 * or a closed word HQ stores where its page shows a label (`hqPageLabels.ts`).
 * `hqPageLabels.test.ts` holds the rule; the suites that read HQ's own shapes
 * and formats read through `namingFromHqPages`, so every finding they meet is
 * held to it too.
 */
import { expect } from "vitest";
import type { Finding } from "@/lib/publish/hqFindings";
import { COLUMN_FORMAT_LABELS, WORKFLOW_LABELS } from "../hqPageLabels";

/** Every word a map of `hqPageLabels.ts` holds: the stored words a finding must never show. */
const STORED_WORDS: ReadonlySet<string> = new Set(
	[COLUMN_FORMAT_LABELS, WORKFLOW_LABELS].flatMap((labels) => [
		...labels.keys(),
	]),
);

/** A manifest finding's name a person would not know from HQ's pages, or undefined. */
export function storedName(finding: Finding): string | undefined {
	const name = (finding.detail as { name?: unknown }).name;
	if (typeof name !== "string") return undefined;
	return name.startsWith("schema:") ||
		name.includes("_cc_calculated_") ||
		STORED_WORDS.has(name)
		? name
		: undefined;
}

/** The manifest's findings (an entry's id, `<area>/<slug>`), the circumstances left out. */
export const manifestFindings = (findings: readonly Finding[]) =>
	findings.filter((one) => one.code.includes("/"));

/** Each manifest finding that shows a stored name, as `<entry>: <name>`. */
export function storedNames(findings: readonly Finding[]): string[] {
	return manifestFindings(findings).flatMap((one) => {
		const name = storedName(one);
		return name === undefined ? [] : [`${one.code}: ${name}`];
	});
}

/** A reading function whose every reading is held to the rule before the caller sees it. */
export function namingFromHqPages<
	A extends unknown[],
	R extends { readonly findings: readonly Finding[] },
>(read: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	return async (...args) => {
		const reading = await read(...args);
		expect(storedNames(reading.findings)).toEqual([]);
		return reading;
	};
}
