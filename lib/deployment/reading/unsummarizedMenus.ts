import "server-only";

/**
 * The findings a reading gives for the menus CommCare HQ could not summarize.
 *
 * CommCare HQ's application resource summarizes each menu inside one `try`
 * (`api/resources/v0_4.py::ApplicationResource.dehydrate_module`): the app's
 * case properties, then every form of the menu through `get_questions`, which
 * parses the form's source. Any exception there makes the whole menu an error
 * entry, whose text quotes the app and is never read. Where every basic and
 * advanced menu of two or more is an error, the cause is in no one menu, and
 * the app's finding ends the reading before the reader runs. Otherwise each
 * such menu has a finding, unless the reading's own findings already name a
 * form of that menu CommCare HQ will not save or build: that finding is the
 * cause a person fixes, and the menu's would be a second finding for it.
 */

import {
	type HqAlignedModule,
	notSummarizedMenus,
} from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { circumstanceFinding, type Finding } from "@/lib/publish/hqFindings";

export interface UnsummarizedMenus {
	/** Whether the one finding is the app's, which ends the reading as an account. */
	readonly app: boolean;
	readonly findings: readonly Finding[];
}

/** One finding at each menu CommCare HQ could not summarize, or the app's one. */
export function unsummarizedFindings(
	source: HqAppSource,
	modules: readonly HqAlignedModule[],
): UnsummarizedMenus {
	const answer = notSummarizedMenus(modules);
	if (answer.kind === "none") return { app: false, findings: [] };
	if (answer.kind === "app")
		return {
			app: true,
			findings: [
				circumstanceFinding("app-unreadable-in-hq", { kind: "app" }, {}),
			],
		};
	const rawMenus = Array.isArray(source.raw.modules)
		? (source.raw.modules as unknown[])
		: [];
	const first = source.langs[0];
	return {
		app: false,
		findings: answer.indexes.map((menu) => {
			const raw = rawMenus[menu];
			const names =
				typeof raw === "object" && raw !== null
					? (raw as { readonly name?: unknown }).name
					: undefined;
			const name =
				first !== undefined &&
				typeof names === "object" &&
				names !== null &&
				typeof (names as Record<string, unknown>)[first] === "string"
					? ((names as Record<string, unknown>)[first] as string)
					: "";
			return circumstanceFinding(
				"menu-unreadable-in-hq",
				{ kind: "menu", menu, name },
				{},
			);
		}),
	};
}

/**
 * Whether `finding` names a form of menu `menu`, or one of its questions, that
 * CommCare HQ will not save or build: a finding whose fix cause says CommCare
 * HQ refuses the thing (`hq-refuses`, or `either`, which also breaks when the
 * app runs).
 */
function namesUnbuildableFormOf(finding: Finding, menu: number): boolean {
	if (finding.subject === null) return false;
	if (finding.cause !== "hq-refuses" && finding.cause !== "either")
		return false;
	const { place } = finding;
	return (
		(place.kind === "form" || place.kind === "question") && place.menu === menu
	);
}

/**
 * The menu findings of `unsummarized` that stand beside `reading`, every other
 * finding of the same account: a menu's finding is left out where `reading`
 * names a form of that menu CommCare HQ will not save or build. The app's
 * finding is never left out.
 */
export function unsummarizedBeside(
	unsummarized: UnsummarizedMenus,
	reading: readonly Finding[],
): readonly Finding[] {
	if (unsummarized.app) return unsummarized.findings;
	return unsummarized.findings.filter((finding) => {
		const { place } = finding;
		if (finding.code !== "menu-unreadable-in-hq" || place.kind !== "menu")
			return true;
		return !reading.some((other) => namesUnbuildableFormOf(other, place.menu));
	});
}
