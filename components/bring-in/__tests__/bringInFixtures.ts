/**
 * Answers of the bring-in routes as the model meets them: keys, reviews with
 * their platform choices and table choices, and the findings of an account.
 * Each is the production type, built whole, so the model reads exactly what a
 * route would answer.
 */

import type {
	BringInInput,
	ReadingDeclarationChoice,
	ReadingKey,
	ReadingReview,
	ReviewTable,
} from "@/lib/deployment";
import type { Platform } from "@/lib/domain/platforms";
import type {
	FirstPublishChangeId,
	FirstPublishView,
} from "@/lib/publish/firstPublishChangeIds";
import type {
	FindingStanding,
	HqPlace,
	ManifestFinding,
	Subject,
} from "@/lib/publish/hqFindings";
import type { ReviewAnswer } from "../bringInModel";

export const KEY: ReadingKey = {
	projectId: "project-1",
	server: "production",
	domain: "demo-space",
	remoteAppId: "a1b2c3d4e5f6",
};

export const OTHER_KEY: ReadingKey = { ...KEY, remoteAppId: "f6e5d4c3b2a1" };

export const READING_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const DIGEST_1 = "a".repeat(64);
export const DIGEST_2 = "b".repeat(64);
export const DIGEST_3 = "c".repeat(64);

export function view(
	ids: readonly FirstPublishChangeId[],
	touchesWorkers: boolean,
): FirstPublishView {
	return { ids, touchesWorkers, of: "first-publish" };
}

export function choice(
	runsOnlyOn: Platform | null,
	options: {
		readonly splitDatetime?: boolean;
		readonly preselected?: boolean;
		readonly firstPublish?: FirstPublishView;
	} = {},
): ReadingDeclarationChoice {
	return {
		runsOnlyOn,
		splitDatetime: options.splitDatetime ?? false,
		preselected: options.preselected ?? false,
		recordedFeatures: [],
		firstPublish:
			options.firstPublish ?? view(["forms-and-settings-rewritten"], false),
	};
}

/** A table whose tag meets a Project table, offering the answers named. */
export function choiceTable(
	tag: string,
	offered: { readonly hq: boolean; readonly project: boolean },
): ReviewTable {
	const offer = (on: boolean) =>
		on
			? { offered: true as const, goneColumns: [], retypedColumns: [] }
			: { offered: false as const, why: "needs-admin" as const, name: null };
	return {
		tag,
		standing: "choice",
		hqDigest: "d".repeat(64),
		projectTable: null,
		choice: {
			differs: ["rows"],
			apps: [],
			options: {
				"use-commcare-hq": offer(offered.hq),
				"use-project": offer(offered.project),
			},
		},
	};
}

/** A table that comes in as it is, asking nothing. */
export function newTable(tag: string): ReviewTable {
	return {
		tag,
		standing: "new",
		hqDigest: "e".repeat(64),
		projectTable: null,
		choice: null,
	};
}

export function review(overrides: Partial<ReadingReview> = {}): ReadingReview {
	const runsOn = overrides.runsOn ?? [choice(null, { preselected: true })];
	const preselected = runsOn.find((entry) => entry.preselected) ?? runsOn[0];
	return {
		appName: "Household visits",
		readAt: "2026-11-15T09:00:00.000Z",
		creates: {
			menus: 2,
			forms: 5,
			questions: 40,
			caseTypes: ["household"],
			languages: ["en"],
			mediaFiles: 0,
		},
		runsOnWhy: "content",
		webAppsOnInHq: true,
		datetimeQuestions: 0,
		platformsOut: [],
		kept: [],
		tables: [],
		places: null,
		mediaLeftOut: 0,
		firstPublish:
			preselected?.firstPublish ??
			view(["forms-and-settings-rewritten"], false),
		...overrides,
		runsOn,
	};
}

export function reviewAnswer(
	body: ReadingReview,
	reviewDigest: string = DIGEST_1,
): ReviewAnswer {
	return { kind: "review", readingId: READING_ID, reviewDigest, review: body };
}

export function inputFor(
	key: ReadingKey = KEY,
	overrides: Partial<BringInInput> = {},
): BringInInput {
	return {
		...key,
		readingId: READING_ID,
		reviewDigest: DIGEST_1,
		appName: "Household visits",
		runsOnlyOn: null,
		splitDatetime: false,
		tableChoices: {},
		...overrides,
	};
}

export const FORM_PLACE = (menu: number, form: number): HqPlace => ({
	kind: "form",
	menu,
	form,
	menuName: `Menu ${menu}`,
	name: `Form ${form}`,
});

export const QUESTION_PLACE = (
	menu: number,
	form: number,
	path: string,
): HqPlace => ({
	kind: "question",
	menu,
	form,
	menuName: `Menu ${menu}`,
	formName: `Form ${form}`,
	path,
});

export function manifestFinding(
	place: HqPlace,
	options: {
		readonly subject?: Subject;
		readonly standing?: Exclude<FindingStanding, "fix-in-hq">;
		readonly name?: string;
		readonly code?: string;
	} = {},
): ManifestFinding {
	return {
		code: options.code ?? "question-appearance-unsupported",
		standing: options.standing ?? "not-yet",
		place,
		subject: options.subject ?? "question-appearance",
		detail: options.name === undefined ? {} : { name: options.name },
	};
}
