/**
 * The words of every finding a reading of an app in CommCare HQ reports: the
 * label and next step of each standing, a sentence for each subject and
 * standing, a stem and a clause for each subject and cause of a thing to
 * change in CommCare HQ, and a block for each circumstance.
 *
 * Client-safe: the builder's account of a reading and MCP both read it, so a
 * person and a client read one wording. `circumstanceBlock` is the one
 * function that fills a circumstance's placeholders, so no two surfaces can
 * fill them differently.
 */

import type {
	CircumstanceFinding,
	Finding,
	FindingStanding,
	FixCause,
	HqAppClaimDetail,
	HqPlace,
	ReadCircumstance,
	Subject,
} from "./hqFindings";
import { CIRCUMSTANCE_STANDINGS } from "./hqFindings";
import { namesInWords } from "./planFeatures";

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export const FINDING_LABELS: Readonly<Record<FindingStanding, string>> = {
	"not-yet": "Nova can't hold this yet",
	never: "Nova doesn't bring this in",
	"fix-in-hq": "Something to change in CommCare HQ",
};

export const FINDING_NEXT_STEPS: Readonly<Record<FindingStanding, string>> = {
	"not-yet":
		"There is nothing for you to change. You can check again whenever you like.",
	never:
		"The app can come in once it no longer uses this. If your team relies on it, the app is best kept in CommCare HQ.",
	"fix-in-hq":
		"Once this is changed in CommCare HQ, you can check again and Nova will read the app afresh.",
};

/** The line under every account's groups. */
export const ACCOUNT_CHECK_AGAIN_LINE =
	"When you check again, Nova may find more to name.";

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export const SUBJECT_LABELS: Readonly<Record<Subject, string>> = {
	"advanced-forms": "Advanced forms",
	"after-submit": "After a form is sent",
	"android-app-dependencies": "Android app dependencies",
	"app-document": "The app as stored",
	"app-logos": "App logos",
	"app-settings": "App settings",
	"auto-select": "Choosing a case automatically",
	"blank-form": "Forms with no questions",
	"call-center-indicators": "Call center indicators",
	"case-attachments": "Files saved on a case",
	"case-detail-tabs": "Case detail tabs",
	"case-list-callout": "Case list lookups",
	"case-list-columns": "Case list and detail columns",
	"case-list-filter": "Case list filters",
	"case-list-optimizations": "Case list speed settings",
	"case-list-registration": "Registration from the case list",
	"case-list-setup": "Case list setup",
	"case-list-sorting": "Case list order",
	"case-list-text": "Case list wording",
	"case-preloads": "Loading case values into questions",
	"case-property-names": "Case property names",
	"case-sharing": "Case sharing",
	"case-tiles": "Case tiles",
	"case-types": "Case types",
	"child-cases": "Child cases",
	"commcare-version": "CommCare version",
	"connect-blocks": "CommCare Connect",
	"custom-assertions": "Custom assertions",
	"custom-device-properties": "Custom device properties",
	"data-registry": "Data registries",
	"data-sources": "Data a form or list reads",
	"deep-links": "Deep links",
	"display-conditions": "Display conditions",
	"display-only-forms": "Forms shown in the menu above",
	expressions: "Expressions",
	"form-case-management": "Case management",
	"form-settings": "Form settings",
	"form-source": "A form's source",
	"hand-written-content": "Hand-written XML",
	"hierarchical-locations": "The older organization list",
	"language-codes": "Language codes",
	"lookup-selection": "Choosing from a lookup table first",
	"lookup-tables": "Lookup tables",
	"media-by-language": "Media by language",
	"media-files": "Media files",
	"menu-badges": "Menu badges",
	"menu-display": "Grid menus",
	"menu-settings": "Menu settings",
	"menu-structure": "How menus are nested",
	"mirror-menus": "Mirror menus",
	"missing-media-files": "Missing media files",
	"mobile-reports": "Mobile reports",
	"parent-selection": "Choosing a parent case first",
	"print-templates": "Print templates",
	"question-appearance": "How a question looks",
	"question-choices": "Choices",
	"question-ids": "Question IDs",
	"question-logic": "Question logic",
	"question-media": "Media on questions",
	"question-text": "Question text",
	"question-types": "Kinds of question",
	repeats: "Repeat groups",
	"save-to-case": "Save to Case questions",
	"search-default-filters": "Search filters",
	"search-expressions": "Search expressions",
	"search-fields": "Search fields",
	"search-setup": "Search setup",
	"shadow-forms": "Shadow forms",
	"supply-features": "CommCare Supply",
	"training-menus": "Training menus",
	"visit-scheduler": "Visit schedules",
	"worker-record": "The worker's own record",
	"writer-types": "Answers of different kinds",
};

// ---------------------------------------------------------------------------
// Sentences of manifest findings
// ---------------------------------------------------------------------------

/**
 * One sentence per subject for each of the two standings a cause does not
 * split. "Here" is the place the account prints above the sentence.
 */
export const FINDING_COPY: Readonly<
	Record<
		Subject,
		Partial<Record<Exclude<FindingStanding, "fix-in-hq">, string>>
	>
> = {
	"advanced-forms": {
		"not-yet":
			"This uses a way of loading or opening cases in an advanced form, which Nova can't hold yet.",
	},
	"after-submit": {
		never:
			"This uses a destination after the form is sent, which Nova doesn't bring in.",
	},
	"android-app-dependencies": {
		"not-yet":
			"This uses a list of Android apps the phone must have, which Nova can't hold yet.",
	},
	"app-document": {
		never:
			"A menu here has no ID in CommCare HQ, so Nova has nothing to keep it by.",
	},
	"app-logos": {
		"not-yet":
			"This uses logos for the Android home, sign-in and practice screens, which Nova can't hold yet.",
	},
	"app-settings": {
		never: "This uses an app setting, which Nova doesn't bring in.",
		"not-yet": "This uses an app setting, which Nova can't hold yet.",
	},
	"auto-select": {
		"not-yet":
			"This uses a setting that chooses a case for the worker, which Nova can't hold yet.",
	},
	"blank-form": {},
	"call-center-indicators": {
		never: "This uses call center indicators, which Nova doesn't bring in.",
	},
	"case-attachments": {
		never:
			"This uses pictures or files saved on a case itself, which Nova doesn't bring in.",
	},
	"case-detail-tabs": {
		"not-yet":
			"This uses tabs on the case detail screen, which Nova can't hold yet.",
	},
	"case-list-callout": {
		"not-yet":
			"This uses a lookup from the case list into another Android app, which Nova can't hold yet.",
	},
	"case-list-columns": {
		never: "This uses a column format, which Nova doesn't bring in.",
		"not-yet": "A column here is set up in a way Nova can't hold yet.",
	},
	"case-list-filter": {
		"not-yet":
			"The case list filter here is more than Nova can read as a condition yet.",
	},
	"case-list-optimizations": {
		never: "This uses a case list speed setting, which Nova doesn't bring in.",
		"not-yet":
			"This uses a case list speed setting, which Nova can't hold yet.",
	},
	"case-list-registration": {
		"not-yet":
			"This uses a way of offering a form from the case list, which Nova can't hold yet.",
	},
	"case-list-setup": {
		"not-yet": "This case list is set up in a way Nova can't hold yet.",
	},
	"case-list-sorting": {
		"not-yet":
			"This uses a way of ordering the case list, which Nova can't hold yet.",
	},
	"case-list-text": {
		"not-yet":
			"This uses its own wording for an empty list or the Continue button, which Nova can't hold yet.",
	},
	"case-preloads": {
		"not-yet":
			"This uses a way of loading a case value into a question, which Nova can't hold yet.",
	},
	"case-property-names": {
		"not-yet": "A case property name here is one Nova can't hold yet.",
	},
	"case-sharing": {
		"not-yet": "This uses case sharing, which Nova can't hold yet.",
	},
	"case-tiles": {
		"not-yet": "This uses a case tile layout, which Nova can't hold yet.",
	},
	"case-types": {},
	"child-cases": {
		never:
			"This form opens a case of its menu's own type, and this project space leaves out the link between the two.",
	},
	"commcare-version": {},
	"connect-blocks": {
		"not-yet":
			"A CommCare Connect block here is set up in a way Nova can't hold yet.",
	},
	"custom-assertions": {
		never: "This uses custom assertions, which Nova doesn't bring in.",
	},
	"custom-device-properties": {
		never: "This uses custom device properties, which Nova doesn't bring in.",
	},
	"data-registry": {
		never: "This uses a data registry, which Nova doesn't bring in.",
	},
	"data-sources": {
		"not-yet":
			"A results screen or a form here reads a search answer in a way Nova can't hold yet.",
	},
	"deep-links": {
		never:
			"A deep link ID on a mirror menu here has a space at its start or end, which Nova can't keep exactly.",
		"not-yet":
			"This uses a deep link with its own arguments, which Nova can't hold yet.",
	},
	"display-conditions": {
		"not-yet":
			"A display condition here is more than Nova can read as a condition yet.",
	},
	"display-only-forms": {
		"not-yet":
			"A form here goes back to, or opens through, the menu above in a way Nova can't hold yet.",
	},
	expressions: {},
	"form-case-management": {
		"not-yet":
			"This form's case management is set up in a way Nova can't hold yet.",
	},
	"form-settings": {
		"not-yet": "This uses a form setting, which Nova can't hold yet.",
	},
	"form-source": {},
	"hand-written-content": {
		never:
			"This uses hand-written XML or settings that no CommCare HQ page edits, which Nova doesn't bring in.",
	},
	"hierarchical-locations": {
		never:
			"This uses the older, nested list of places, which Nova doesn't bring in.",
	},
	"language-codes": {},
	"lookup-selection": {
		never:
			"This uses choosing from a lookup table before the case list, which Nova doesn't bring in.",
	},
	"lookup-tables": {
		"not-yet":
			"A lookup table here uses something Nova can't hold yet, or is larger than Nova takes.",
	},
	"media-by-language": {
		"not-yet":
			"This uses a picture or sound that differs by language, which Nova can't hold yet.",
	},
	"media-files": {
		"not-yet":
			"A media file here is larger than Nova takes, or this app has more media than Nova takes.",
	},
	"menu-badges": {
		"not-yet":
			"This uses a badge on a menu or form, which Nova can't hold yet.",
	},
	"menu-display": {
		"not-yet": "This uses grid menus, which Nova can't hold yet.",
	},
	"menu-settings": {},
	"menu-structure": {
		never:
			"The menus here are in an order that separates a menu from the one above it.",
		"not-yet": "How this menu is nested is something Nova can't hold yet.",
	},
	"mirror-menus": {
		never:
			"This uses the older kind of mirror menu, which Nova doesn't bring in.",
		"not-yet": "This uses a mirror menu, which Nova can't hold yet.",
	},
	"missing-media-files": {},
	"mobile-reports": {
		never: "This uses mobile reports, which Nova doesn't bring in.",
	},
	"parent-selection": {
		never:
			"This uses a first case that is no parent of the second, which Nova doesn't bring in.",
		"not-yet": "This chooses a parent case first in a way Nova can't hold yet.",
	},
	"print-templates": {
		never: "This uses a print template, which Nova doesn't bring in.",
	},
	"question-appearance": {
		never: "This uses a display style, which Nova doesn't bring in.",
		"not-yet": "A question here has a display style Nova can't hold yet.",
	},
	"question-choices": {
		"not-yet":
			"A question's choices here are set up in a way Nova can't hold yet.",
	},
	"question-ids": {
		never:
			"Two questions here share one place in the form's data, so Nova can't tell them apart.",
	},
	"question-logic": {
		"not-yet": "A question's logic here is something Nova can't hold yet.",
	},
	"question-media": {
		"not-yet":
			"A question here carries a kind of media or label form Nova can't hold yet.",
	},
	"question-text": {
		"not-yet": "This uses a kind of question text, which Nova can't hold yet.",
	},
	"question-types": {
		"not-yet":
			"A question here is of a kind, or is set up in a way, that Nova can't hold yet.",
	},
	repeats: {
		"not-yet": "A repeat group here is set up in a way Nova can't hold yet.",
	},
	"save-to-case": {
		"not-yet": "This uses a Save to Case question, which Nova can't hold yet.",
	},
	"search-default-filters": {
		never:
			"A search filter here sets how the search itself runs from a value worked out on the device.",
		"not-yet": "This uses a search filter, which Nova can't hold yet.",
	},
	"search-expressions": {
		never: "This uses a search expression, which Nova doesn't bring in.",
		"not-yet": "This uses a search expression, which Nova can't hold yet.",
	},
	"search-fields": {
		"not-yet": "A search field here is set up in a way Nova can't hold yet.",
	},
	"search-setup": {
		never: "This uses a search setting, which Nova doesn't bring in.",
		"not-yet": "This uses a search setting, which Nova can't hold yet.",
	},
	"shadow-forms": {
		"not-yet": "This uses a shadow form, which Nova can't hold yet.",
	},
	"supply-features": {
		never: "This uses CommCare Supply features, which Nova doesn't bring in.",
	},
	"training-menus": {
		never:
			"This uses a training menu or release notes form, which Nova doesn't bring in.",
	},
	"visit-scheduler": {
		never: "This uses a visit schedule, which Nova doesn't bring in.",
	},
	"worker-record": {
		never:
			"A question here is named commcare_usercase, the name CommCare HQ gives the worker's own record.",
		"not-yet":
			"This reads or writes the worker's own record in a way Nova can't hold yet.",
	},
	"writer-types": {
		"not-yet":
			"A case property here takes answers of kinds that don't match, which Nova can't hold yet.",
	},
};

/** What is set up, ending in its verb: "Case sharing is", "A question's choices are". */
export const FIX_IN_HQ_STEMS: Readonly<Partial<Record<Subject, string>>> = {
	"advanced-forms": "The cases this advanced form loads or opens are",
	"after-submit": "Where this form goes after it is sent is",
	"android-app-dependencies": "The Android apps this app depends on are",
	"app-logos": "An app logo is",
	"app-settings": "An app setting is",
	"auto-select": "Choosing a case automatically is",
	"case-detail-tabs": "A tab on the case detail screen is",
	"case-list-callout": "A lookup from the case list is",
	"case-list-columns": "A column is",
	"case-list-filter": "The case list filter is",
	"case-list-registration": "The form offered from the case list is",
	"case-list-setup": "The case list is",
	"case-list-sorting": "A sort rule is",
	"case-preloads": "A question that loads a case value is",
	"case-property-names": "A case property name is",
	"case-sharing": "Case sharing is",
	"case-tiles": "A case tile is",
	"child-cases": "A child case is",
	"connect-blocks": "A CommCare Connect block is",
	"data-sources": "Something this app reads from the device is",
	"deep-links": "A deep link is",
	"display-conditions": "A display condition is",
	"display-only-forms": "A menu whose forms show in the menu above is",
	"form-case-management": "This form's case management is",
	"form-settings": "A form setting is",
	"form-source": "Part of this form's source is",
	"lookup-tables": "A lookup table is",
	"menu-settings": "A menu setting is",
	"menu-structure": "How this menu is nested is",
	"mirror-menus": "A mirror menu is",
	"parent-selection": "Choosing a parent case first is",
	"question-appearance": "A question's display style is",
	"question-choices": "A question's choices are",
	"question-logic": "A question's logic is",
	"question-media": "Media on a question is",
	"question-text": "A question's text is",
	"question-types": "A question is",
	repeats: "A repeat group is",
	"save-to-case": "A Save to Case question is",
	"search-default-filters": "A search filter is",
	"search-expressions": "A search expression is",
	"search-fields": "A search field is",
	"search-setup": "The search is",
	"shadow-forms": "A shadow form is",
	"worker-record": "A use of the worker's own record is",
};

/** How it is set up, by cause. `below-floor` has no clause: its one sentence is whole. */
export const FIX_CAUSE_CLAUSES: Readonly<
	Record<Exclude<FixCause, "below-floor">, string>
> = {
	"hq-refuses": "set up in a way CommCare HQ can't save or build.",
	"breaks-when-run":
		"set up in a way that doesn't work when the app runs, though CommCare HQ builds it.",
	either:
		"set up in a way CommCare HQ can't save or build, or that doesn't work when the app runs.",
};

/** A whole sentence for one subject and cause, which is read in place of stem and clause. */
export const FIX_IN_HQ_SENTENCES: Readonly<
	Partial<Record<Subject, Partial<Record<FixCause, string>>>>
> = {
	"app-document": {
		"hq-refuses":
			"Part of how this app is stored is something CommCare HQ can't save or build.",
	},
	"blank-form": {
		"hq-refuses":
			"A form here has no questions, which CommCare HQ won't build.",
	},
	"case-types": {
		"hq-refuses":
			"A case type here holds a character CommCare HQ's menu settings can't save.",
	},
	"commcare-version": {
		"below-floor":
			"This app is built for a CommCare version below 2.57, the earliest Nova publishes to.",
	},
	expressions: {
		"breaks-when-run":
			"An expression here is one CommCare can't run, though CommCare HQ builds it.",
		either:
			"An expression here is one CommCare can't run or CommCare HQ can't build.",
		"hq-refuses": "An expression here is one CommCare HQ can't build.",
	},
	"language-codes": {
		"hq-refuses":
			"A language code here is one CommCare HQ's Languages page can't save.",
	},
	"media-files": {
		"breaks-when-run":
			"A media file here is in a format CommCare can't show or play.",
		"hq-refuses":
			"A media file here is kept at a path CommCare HQ can't build into the app.",
	},
	"missing-media-files": {
		"breaks-when-run":
			"The app points at a media file here that CommCare HQ doesn't have. Workers meet a missing file there, and Android may not start the app at all.",
	},
	"question-ids": {
		"hq-refuses":
			"A question ID here is one CommCare HQ's form builder can't keep.",
	},
};

/** The sentence a `fix-in-hq` finding of this subject and cause reads. */
export function fixInHqSentence(subject: Subject, cause: FixCause): string {
	const whole = FIX_IN_HQ_SENTENCES[subject]?.[cause];
	if (whole !== undefined) return whole;
	const stem = FIX_IN_HQ_STEMS[subject];
	if (stem !== undefined && cause !== "below-floor")
		return `${stem} ${FIX_CAUSE_CLAUSES[cause]}`;
	throw new Error(
		`A finding of the subject "${subject}" with the cause "${cause}" has no sentence to read. Every pair a manifest entry gives needs a stem in FIX_IN_HQ_STEMS (with a clause for the cause) or a whole sentence in FIX_IN_HQ_SENTENCES, in lib/publish/hqFindingCopy.ts.`,
	);
}

// ---------------------------------------------------------------------------
// Places and lines
// ---------------------------------------------------------------------------

/** A place, as one line: "Registration, in the menu Households". */
export function placeLine(place: HqPlace): string {
	switch (place.kind) {
		case "app":
			return "The app";
		case "app-settings":
			return "App settings";
		case "languages":
			return "Languages";
		case "menu":
			return `The menu ${place.name}`;
		case "case-list":
			return `The case list of ${place.name}`;
		case "case-detail":
			return `The case details of ${place.name}`;
		case "search":
			return `The search of ${place.name}`;
		case "form":
			return `${place.name}, in the menu ${place.menuName}`;
		case "question":
			return `The question ${place.path}, in ${place.formName}`;
		case "lookup-table":
			return `The lookup table ${place.tag}`;
		case "media":
			return `The file ${place.path}`;
		case "organization":
			return "The organization";
	}
}

/**
 * One finding as the account shows it. A manifest finding reads its pair's
 * sentence; a circumstance an account holds reads its block's title, and
 * `circumstanceBlock` gives its body and next step. A stop is shown where the
 * person stands and is never in an account.
 */
export function findingLine(finding: Finding): {
	readonly sentence: string;
	/**
	 * `detail.name`, shown after the sentence as "In CommCare HQ: <name>", for a manifest finding
	 * and for a circumstance whose row holds `name: "line"`; null otherwise.
	 */
	readonly named: string | null;
} {
	if (finding.subject === null) {
		if (finding.standing === "stop")
			throw new Error(
				`The circumstance "${finding.code}" ends a reading, so no account holds it. A stop is worded by circumstanceBlock where the person stands.`,
			);
		const row: { readonly standing: string; readonly name?: string } =
			CIRCUMSTANCE_STANDINGS[finding.code];
		return {
			sentence: CIRCUMSTANCE_COPY[finding.code].title,
			named: row.name === "line" ? (finding.detail.name ?? null) : null,
		};
	}
	return {
		sentence: manifestSentence(
			finding.subject,
			finding.standing,
			finding.cause,
			finding.code,
		),
		named: finding.detail.name ?? null,
	};
}

function manifestSentence(
	subject: Subject,
	standing: FindingStanding,
	cause: FixCause | undefined,
	code: string,
): string {
	if (standing === "fix-in-hq") {
		if (cause === undefined)
			throw new Error(
				`The finding for "${code}" is something to change in CommCare HQ but carries no cause, so there is no sentence to choose. A manifest finding takes its cause from fixCauseOf(entry).`,
			);
		return fixInHqSentence(subject, cause);
	}
	const sentence = FINDING_COPY[subject][standing];
	if (sentence === undefined)
		throw new Error(
			`A finding of the subject "${subject}" with the standing "${standing}" has no sentence to read (it came from "${code}"). Every pair a manifest entry gives needs its sentence in FINDING_COPY, in lib/publish/hqFindingCopy.ts.`,
		);
	return sentence;
}

// ---------------------------------------------------------------------------
// Circumstances
// ---------------------------------------------------------------------------

export interface CircumstanceCopy {
	readonly title: string;
	readonly body: string;
	/** What the person can do next, as an invitation. */
	readonly next: string;
}

/**
 * One block per circumstance, as templates. `{server}` is the server's label,
 * `{space}` the project space, `{app}` the HQ app's name ("this app" where
 * none is known), and `{name}` the finding's `detail.name`.
 * `circumstanceBlock` fills them.
 */
export const CIRCUMSTANCE_COPY: Readonly<
	Record<ReadCircumstance, CircumstanceCopy>
> = {
	"not-connected": {
		title: "Nova isn't connected to CommCare HQ on {server} yet",
		body: "Nova has no CommCare HQ account of yours on {server} to read with.",
		next: "You can connect one in Settings, then come back here.",
	},
	"key-not-accepted": {
		title: "CommCare HQ didn't accept your API key",
		body: "Nova tried to read {space} with your saved key and CommCare HQ turned it down. The key may have been removed or replaced.",
		next: "You can save a new key in Settings, then check again.",
	},
	"key-cannot-reach-space": {
		title: "Your saved key doesn't reach this project space",
		body: "The CommCare HQ key Nova has for you on {server} doesn't list {space}. It may be limited to another project space, or you may have joined {space} after it was saved.",
		next: "You can refresh your project spaces or save a new key in Settings, then check again.",
	},
	"plan-lacks-api-access": {
		title: "This project space's plan has no API access",
		body: "Nova reads an app through CommCare HQ's API, and {space}'s plan doesn't include it.",
		next: "Once the plan includes API access, you can check again. Someone who manages the project space's subscription can say when.",
	},
	"api-cut-off": {
		title: "CommCare HQ has paused API access",
		body: "CommCare HQ has paused API access for your account or for {space} after too many requests. Your key and the plan are fine.",
		next: "Dimagi support (support@dimagi.com) can turn it back on. Then you can check again.",
	},
	"not-a-member": {
		title: "Your account isn't part of this project space",
		body: "CommCare HQ says your account is no member of {space}, so Nova can't read its apps.",
		next: "You can ask an admin of {space} to add you, or choose another project space.",
	},
	"cannot-edit-apps": {
		title: "Your account can't edit apps here",
		body: "Reading an app and the lookup tables it uses needs the Edit Apps permission on {space}, and your account doesn't have it.",
		next: "You can ask an admin of {space} for Edit Apps, then check again.",
	},
	"cannot-access-apis": {
		title: "Your account can't use the API here",
		body: "Reading an app's forms and its list of lookup tables needs the Access APIs permission on {space}, and your account doesn't have it.",
		next: "You can ask an admin of {space} for Access APIs, then check again.",
	},
	"cannot-read-organization": {
		title: "Nova couldn't read this project space's organization",
		body: "{app} reads places, and reading them from {space} needs Locations on its plan and the Edit Locations permission on your account. CommCare HQ doesn't say which of the two is missing.",
		next: "An admin of {space} can check both. Then you can check again.",
	},
	"app-gone": {
		title: "CommCare HQ no longer has this app",
		body: "Nova asked {space} for {app}, and CommCare HQ holds no app by that ID. It may have been deleted.",
		next: "You can go back and choose from the apps {space} has now.",
	},
	"app-deleted": {
		title: "This app was deleted in CommCare HQ",
		body: "{app} is in {space}'s deleted apps, so there is nothing current for Nova to read.",
		next: "If it was deleted by mistake, you can restore it in CommCare HQ and check again.",
	},
	"linked-app": {
		title: "Nova can't bring in a linked app",
		body: "{app} is a linked app. CommCare HQ rewrites it from another app each time that one is pulled, so nothing Nova published to it would stay.",
		next: "You can bring in the app it is linked from instead.",
	},
	"remote-app": {
		title: "This app isn't kept in CommCare HQ",
		body: "{app} is hosted outside CommCare HQ, which only links to it, so there's nothing here for Nova to bring in.",
		next: "You can go back and choose another app from {space}.",
	},
	"rate-limited": {
		title: "CommCare HQ is busy",
		body: "CommCare HQ asked Nova to slow down, and it was still busy after Nova waited.",
		next: "You can check again in a few minutes. Nothing was changed.",
	},
	"hq-unavailable": {
		title: "CommCare HQ didn't answer",
		body: "Nova couldn't finish reading from CommCare HQ. It didn't answer in time, or it sent something Nova couldn't read.",
		next: "You can check again. If it keeps happening, CommCare HQ's status page may say why.",
	},
	"hq-gateway-refused": {
		title: "A security gateway turned Nova away",
		body: "A security gateway in front of CommCare HQ turned Nova's request away before CommCare HQ saw it, so it says nothing about your key or your permissions.",
		next: "You can check again in a few minutes. If it keeps happening, Dimagi support (support@dimagi.com) can help.",
	},
	"browser-only": {
		title: "CommCare HQ sent a page meant for a browser",
		body: "Nova asked {space} for an app and CommCare HQ answered with a page meant for a person, as it does when a project space asks you to sign in another way or isn't active.",
		next: "Opening {space} in CommCare HQ shows what it's asking for. Once that's settled, you can check again.",
	},
	"changed-while-reading": {
		title: "The app changed while Nova was reading it",
		body: "Someone saved {app} in CommCare HQ while Nova read it, twice in a row, so Nova stopped short of mixing two versions.",
		next: "You can check again once the edits there have settled.",
	},
	"already-in-nova": {
		title: "This app is already in Nova",
		body: "{app} is managed by a Nova app already, and one CommCare HQ app is managed by one Nova app so two can't publish over each other.",
		next: "You can check again in a moment to see where it is.",
	},
	"too-large": {
		title: "This app is larger than Nova brings in",
		body: "{app} is larger than the apps Nova brings in. That limit is Nova's, not the app's.",
		next: "There is nothing for you to change in the app. If you'd like Nova to bring in an app this size, you can tell the team through Give feedback in Nova's account menu.",
	},
	"menu-unreadable-in-hq": {
		title: "CommCare HQ can't summarize this menu",
		body: "CommCare HQ returned an error where its own summary of this menu's forms should be, so Nova has nothing sure to check its reading against.",
		next: "Opening each of the menu's forms in CommCare HQ's form builder usually shows which one is broken. Once it saves cleanly, you can check again.",
	},
	"app-unreadable-in-hq": {
		title: "CommCare HQ can't summarize this app",
		body: "CommCare HQ returned an error where its own summary of this app's forms should be, so Nova has nothing sure to check its reading against.",
		next: "Opening the app's forms in CommCare HQ's form builder usually shows which one is broken. If they all open, Dimagi support (support@dimagi.com) can help. Then you can check again.",
	},
	"shadow-disagrees": {
		title: "A question's logic says two things",
		body: "This question's logic and the copy the form builder keeps of it don't match, so Nova can't tell which one the author meant.",
		next: "Opening the form in CommCare HQ's form builder and saving it makes them match. Then you can check again.",
	},
	"media-file-unreadable": {
		title: "CommCare HQ doesn't have this file",
		body: "The app points at {name}, and CommCare HQ has no file there, so the app can't show or play it either.",
		next: "You can upload the file again in CommCare HQ, or remove it from the app there, then check again.",
	},
	"media-not-played-where-app-runs": {
		title: "A media file doesn't play where this app runs",
		body: "The app points at {name}, and no platform that can run the rest of this app plays that file's format.",
		next: "You can replace it in CommCare HQ with a PNG or JPEG picture, an MP3 sound or an H.264 MP4 video, then check again.",
	},
	"table-rows-unreadable": {
		title: "CommCare HQ couldn't send this table's rows",
		body: "CommCare HQ listed the lookup table {name} and then couldn't send its rows. A row that holds a field with no value is one cause Nova knows of.",
		next: "You can open the table in CommCare HQ and fill in or remove that row, then check again.",
	},
	"table-cell-unrepresentable": {
		title: "A lookup table holds a character CommCare can't carry",
		body: "The lookup table {name} in {space} holds a character CommCare can't carry in a value.",
		next: "You can take that character out in CommCare HQ, then check again.",
	},
	"table-choices-unusable": {
		title: "A lookup table's rows can't be a question's choices",
		body: "A question takes its choices from the lookup table {name} in {space}, and that table has no rows there, or has a row whose value is blank, starts or ends with a space or appears twice, or whose label is blank.",
		next: "You can change those rows in CommCare HQ, then check again.",
	},
	"no-platform-runs-everything": {
		title: "No one platform runs this whole app",
		body: "This uses {name}. Part of this app runs only in Web Apps and part only on Android, so workers on either would meet something that doesn't work.",
		next: "You can change one of these in CommCare HQ so one platform runs everything, then check again.",
	},
	"places-over-nova-limit": {
		title: "This project space has more places than Nova takes",
		body: "{app} reads places, and {space} has {name}. Nova holds up to 10,000 for an app.",
		next: "There is nothing for you to change. You can check again after a Nova update.",
	},
	"place-not-holdable": {
		title: "A place or level is one Nova can't hold yet",
		body: "{name} in {space} has a code, a name or a value Nova can't hold yet.",
		next: "There is nothing for you to change. You can check again after a Nova update.",
	},
	"owner-rule-needs-one-place": {
		title: "An owner rule needs exactly one place",
		body: "{app} gives a case to the place at the level {name} below its current owner. In {space} that isn't exactly one place everywhere, and Nova holds the rule only where it is.",
		next: "There is nothing for you to change. You can check again after a Nova update.",
	},
	unrecognized: {
		title: "Nova met something it doesn't know",
		body: "Nova found something in this app it has no reading for yet. That gap is Nova's, and it has been reported to the team with what it was.",
		next: "There is nothing for you to change. You can check again after a Nova update.",
	},
	"read-back-differs": {
		title: "Nova couldn't confirm what it read",
		body: "Nova read {app}, and one of Nova's own checks on what it read didn't pass. That's Nova's mistake, not the app's, and it has been reported to the team.",
		next: "You can check again after a Nova update.",
	},
};

/** `no-platform-runs-everything`'s next step at a date and time question whose split is refused. */
const SPLIT_REFUSED_NEXT =
	"You can change how the date and time question {question} reads its own answer in CommCare HQ, then check again.";

/** What a surface knows when it draws a circumstance. */
export interface CircumstanceContext {
	/** The server's label. */
	readonly server: string;
	/** The project space. */
	readonly space: string;
	/** The HQ app's name, or null where none is known. */
	readonly app: string | null;
	/** How this surface writes a date: the viewer's locale date on screen, the UTC day over MCP. */
	readonly formatDate: (iso: string) => string;
}

/** A circumstance as every surface shows it, with every placeholder filled. */
export function circumstanceBlock(
	finding: CircumstanceFinding,
	context: CircumstanceContext,
): { readonly title: string; readonly body: string; readonly next: string } {
	const copy = CIRCUMSTANCE_COPY[finding.code];
	const fill = (template: string): string =>
		fillPlaceholders(template, finding, context);
	return {
		title: fill(copy.title),
		body: fill(copy.body),
		next: fill(circumstanceNext(finding, context)),
	};
}

function circumstanceNext(
	finding: CircumstanceFinding,
	context: CircumstanceContext,
): string {
	if (finding.code === "already-in-nova")
		return alreadyInNovaNext(finding.detail.claim, context.formatDate);
	if (
		finding.code === "no-platform-runs-everything" &&
		finding.detail.reason === "split-refused"
	) {
		if (finding.place.kind !== "question")
			throw new Error(
				`The finding "no-platform-runs-everything" says a date and time question's split is refused, but its place is ${placeLine(finding.place).toLowerCase()}, not a question, so its next step can't name the question. The reader raises it with the question's place.`,
			);
		const segments = finding.place.path.split("/").filter((s) => s !== "");
		const question = segments[segments.length - 1] ?? finding.place.path;
		return SPLIT_REFUSED_NEXT.replace("{question}", () => question);
	}
	return CIRCUMSTANCE_COPY[finding.code].next;
}

/**
 * A template with `{server}`, `{space}`, `{name}` and `{app}` filled. `{app}`
 * with no app known reads "this app", and "This app" where it opens a
 * sentence.
 */
function fillPlaceholders(
	template: string,
	finding: CircumstanceFinding,
	context: CircumstanceContext,
): string {
	return template.replace(
		/\{(server|space|name|app)\}/g,
		(_match, key: string, offset: number) => {
			switch (key) {
				case "server":
					return context.server;
				case "space":
					return context.space;
				case "name":
					return finding.detail.name ?? "";
				default: {
					if (context.app !== null) return context.app;
					return opensSentence(template, offset) ? "This app" : "this app";
				}
			}
		},
	);
}

function opensSentence(text: string, offset: number): boolean {
	const before = text.slice(0, offset).trimEnd();
	return before === "" || /[.!?]$/.test(before);
}

/** `already-in-nova`'s next step, which depends on who holds the app. */
export function alreadyInNovaNext(
	claim: HqAppClaimDetail | undefined,
	formatDate: (iso: string) => string,
): string {
	if (claim === undefined) return CIRCUMSTANCE_COPY["already-in-nova"].next;
	if (claim.kind === "open")
		return `It's ${claim.appName}, in a Project you're part of. You can open it from your apps.`;
	const { names, role } = claim.contact;
	if (names.length === 0)
		throw new Error(
			`An app held elsewhere in Nova since ${claim.at} names no one to ask. Who holds an HQ app is read with at least one contact: the person who brought it in, or the holding Project's owners.`,
		);
	const date = formatDate(claim.at);
	if (role === "person") {
		const name = names[0];
		return `${name} has had it in Nova since ${date}. You can ask ${name} to invite you, or to stop publishing to it from Nova so you can bring it in yourself.`;
	}
	return `It has been in Nova since ${date}. ${namesInWords(names)} can invite you, or stop publishing to it from Nova so you can bring it in yourself.`;
}
