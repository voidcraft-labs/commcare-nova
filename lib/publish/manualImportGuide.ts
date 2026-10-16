/**
 * The steps a person takes to bring the HQ import file into CommCare HQ by
 * hand, derived from what the file carries and what the app needs.
 *
 * One derivation, read in three places: the `README.txt` of the import
 * file's ZIP, the publish dialog's outcome after the download, and a text
 * block of the MCP `compile_app` result. The guide takes inputs its callers
 * already derived with the functions a publish's own checks read, so this
 * module imports nothing from `lib/commcare` and the file and a publish
 * never name different requirements. It is never stored.
 */

import {
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "./projectSpaceCompatibility";

export type ManualImportStepKind =
	| "lookup-tables"
	| "import-app"
	| "commcare-version"
	| "media"
	| "capabilities"
	| "plan-features"
	| "logo"
	| "flat-location-fixture"
	| "connect-forwarding";

const STEP_KINDS: ReadonlySet<string> = new Set<ManualImportStepKind>([
	"lookup-tables",
	"import-app",
	"commcare-version",
	"media",
	"capabilities",
	"plan-features",
	"logo",
	"flat-location-fixture",
	"connect-forwarding",
]);

export interface ManualImportStep {
	readonly kind: ManualImportStepKind;
	readonly title: string;
	/** The step's text as the README holds it, one line per entry. */
	readonly lines: readonly string[];
}

export interface ManualImportGuideInput {
	/** The app JSON's member name in the ZIP, without its extension. */
	readonly appFileName: string;
	/** The tag of each lookup table the workbook carries; empty for none. */
	readonly lookupTags: readonly string[];
	readonly hasMedia: boolean;
	/** The floor as text, "2.57". The caller formats it; the guide imports no constant. */
	readonly versionFloor: string;
	/** `ProjectSpaceCapabilityUse`'s label and reasons, one per capability the app needs. */
	readonly capabilities: readonly {
		readonly label: string;
		readonly reasons: readonly string[];
	}[];
	/** The plan features the app's content needs. */
	readonly planFeatures: readonly {
		readonly label: string;
		readonly plans: string;
		readonly consequence: string;
	}[];
	/** The app's logo file, or null for an app with none. */
	readonly logo: { readonly fileName: string } | null;
	/** Whether the app reads the project space's locations. */
	readonly readsLocations: boolean;
	/** Whether the app's forms hold a CommCare Connect block. */
	readonly sendsToConnect: boolean;
}

/** The ZIP's member that holds the lookup tables. */
export const MANUAL_IMPORT_LOOKUP_WORKBOOK = "lookup-tables.xlsx";
/** The ZIP's member that holds the media, in CommCare HQ's bulk-upload format. */
export const MANUAL_IMPORT_MEDIA_ZIP = "multimedia.zip";

/**
 * The lookup step names the page rather than the upload URL because
 * `fixtures/urls.py` answers a GET to `edit_lookup_tables/upload/` with a
 * redirect back to the table list: the upload form lives on the list page
 * (`templates/fixtures/manage_tables.html`), and so does the "Replace
 * existing tables" box that makes CommCare HQ's copy match Nova's. It comes
 * first, so the app finds its data the moment CommCare HQ builds it.
 */
function lookupTablesStep(tags: readonly string[]): ManualImportStep {
	return {
		kind: "lookup-tables",
		title: "Upload the lookup tables",
		lines: [
			"Open the Lookup Tables page in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/fixtures/",
			"",
			`Upload "${MANUAL_IMPORT_LOOKUP_WORKBOOK}" there, tick "Replace existing`,
			"tables\", and click Upload Tables. Replacing makes CommCare's copy of",
			"each table in the file match this export exactly. Tables the file",
			"doesn't mention are left alone.",
			"",
			`The file carries ${tags.join(", ")}. If your project already has a table with one`,
			"of those names, uploading replaces its rows.",
		],
	};
}

/**
 * The dummy App URL is load-bearing, not a placeholder: CommCare HQ's only
 * UI path to upload an app's JSON is "Import App from Another Server", whose
 * first screen requires a source-app URL. That screen never fetches the URL:
 * it validates the shape and checks the subdomain is a CommCare server other
 * than the current one (`domain/forms.py::ExtractAppInfoForm`:
 * `^https://[^/]+/a/(?P<domain>[^/]+)/apps/view/(?P<app_id>[a-f0-9]{32})/?`
 * plus a `{www|india|eu}.commcarehq.org` subdomain check that must differ from
 * `SERVER_ENVIRONMENT`). So a fixed dummy with a 32-hex app id and the `india`
 * subdomain passes the gate; the real JSON is uploaded on the next screen.
 */
function importAppStep(appFileName: string): ManualImportStep {
	return {
		kind: "import-app",
		title: "Import the app",
		lines: [
			"In CommCare HQ, open the Settings (gear) menu -> Project Settings ->",
			"Import App from Another Server:",
			"  https://www.commcarehq.org/a/<your-project>/settings/project/import_app/",
			"",
			"This is the only place CommCare's UI lets you upload an app's JSON. The",
			"first screen asks for an 'App URL' from another server, but it only",
			"checks the URL's shape and that the server differs from yours, it never",
			"opens the link. Paste this exact dummy URL and click Next:",
			"",
			"  https://india.commcarehq.org/a/x/apps/view/00000000000000000000000000000000/",
			"",
			"(If your CommCare instance IS the India server, change 'india' to 'www'.",
			" The only rule: the subdomain must be www, india, or eu, and not yours.)",
			"",
			`On the next screen, upload "${appFileName}.json", name the app, and import.`,
		],
	};
}

function commCareVersionStep(versionFloor: string): ManualImportStep {
	return {
		kind: "commcare-version",
		title: "Check the app's CommCare version",
		lines: [
			`This app needs CommCare ${versionFloor} or later.`,
			"",
			"In CommCare HQ, the app's settings show its CommCare version. If the",
			`version there is lower, you can raise it to ${versionFloor} or later and`,
			"save.",
			"",
			"After that, phones on an older CommCare can no longer install or update",
			"the app.",
		],
	};
}

function mediaStep(): ManualImportStep {
	return {
		kind: "media",
		title: "Import the media",
		lines: [
			"After the app imports, CommCare shows an instructions page with a link to",
			`your new app's multimedia upload. Open it and upload "${MANUAL_IMPORT_MEDIA_ZIP}".`,
			"The files are named by content hash and match the app's references",
			"automatically, so they attach to the right places.",
		],
	};
}

function capabilitiesStep(
	capabilities: ManualImportGuideInput["capabilities"],
): ManualImportStep {
	return {
		kind: "capabilities",
		title: "Check what the project space supports",
		lines: [
			"This app uses features that CommCare HQ turns on for one project space at",
			"a time:",
			"",
			...capabilities.map(
				(capability) =>
					`  - ${capability.label}: ${capability.reasons.join(" ")}`,
			),
			"",
			"If the project space doesn't have one of these yet, Dimagi support can",
			`turn it on for you: ${PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL}. There is`,
			`more about each one at ${PROJECT_SPACE_COMPATIBILITY_DOCS_URL}.`,
		],
	};
}

/**
 * The plan features the app needs, which the import file cannot check: no
 * API key reads a project space's plan, so the person looks for each one on
 * the project space's subscription page.
 */
function planFeaturesStep(
	planFeatures: ManualImportGuideInput["planFeatures"],
): ManualImportStep {
	return {
		kind: "plan-features",
		title: "Check the project space's plan",
		lines: [
			"This app uses features that come with some CommCare HQ plans and not others:",
			"",
			...planFeatures.map(
				(feature) =>
					`  - ${feature.label}: ${feature.plans}. ${feature.consequence}`,
			),
			"",
			"It helps to check that the project space's plan includes each one, on its Current Subscription page in CommCare HQ.",
		],
	};
}

/** The app's logo travels beside the app file, never in it. */
function logoStep(logo: { readonly fileName: string }): ManualImportStep {
	return {
		kind: "logo",
		title: "Your app's logo",
		lines: [
			`The ZIP holds your logo as "${logo.fileName}"; it isn't part of the app file.`,
			"To show it in apps built on CommCare HQ, you can add it in the imported app's settings there. That takes a plan with the Custom CommCare Logo Uploader (Advanced or Enterprise); on other plans, apps built on CommCare HQ carry no logo.",
		],
	};
}

/**
 * Every app carries `project_default`, so phones and Web Apps take the flat
 * location list by the project space's own setting, which nothing here can
 * read.
 */
function flatLocationFixtureStep(): ManualImportStep {
	return {
		kind: "flat-location-fixture",
		title: "The location list",
		lines: [
			"This app reads the places in your organization, on phones and in Web Apps, and its forms that do can't work without them.",
			"It helps to check that the project space still sends its location list to workers. It does unless someone turned that off on its Location Fixture page. Phones and Web Apps both follow that setting.",
		],
	};
}

/** A Connect app's forms reach CommCare Connect only through HQ's data forwarding. */
function connectForwardingStep(): ManualImportStep {
	return {
		kind: "connect-forwarding",
		title: "Check that the app's forms reach CommCare Connect",
		lines: [
			"This app's forms reach CommCare Connect only through CommCare HQ's data forwarding.",
			"It helps to check that the project space's plan includes Data Forwarding and that it has a forwarder set up as Forward Form Metadata to Commcare Connect.",
		],
	};
}

/** The steps that apply to this file, in the order a person takes them. */
export function manualImportGuide(
	input: ManualImportGuideInput,
): readonly ManualImportStep[] {
	return [
		...(input.lookupTags.length > 0
			? [lookupTablesStep(input.lookupTags)]
			: []),
		importAppStep(input.appFileName),
		commCareVersionStep(input.versionFloor),
		...(input.hasMedia ? [mediaStep()] : []),
		...(input.capabilities.length > 0
			? [capabilitiesStep(input.capabilities)]
			: []),
		...(input.planFeatures.length > 0
			? [planFeaturesStep(input.planFeatures)]
			: []),
		...(input.logo === null ? [] : [logoStep(input.logo)]),
		...(input.readsLocations ? [flatLocationFixtureStep()] : []),
		...(input.sendsToConnect ? [connectForwardingStep()] : []),
	];
}

/** The guide as the ZIP's `README.txt` holds it. */
export function renderManualImportGuide(
	steps: readonly ManualImportStep[],
): string {
	return [
		"Import this app into CommCare HQ",
		"",
		...steps.flatMap((step, index) => [
			`=== ${index + 1}. ${step.title} ===`,
			"",
			...step.lines,
			"",
		]),
	].join("\n");
}

/** The response header `/api/compile/json` carries the steps in, for the publish dialog. */
export const MANUAL_IMPORT_GUIDE_HEADER = "X-Nova-Manual-Import-Guide";

/**
 * The most the header's value holds, in encoded characters. Proxies between
 * the route and the browser refuse a response whose headers run long, and a
 * guide that names many lookup tables or capability reasons can, so the
 * header stays well under the limits they commonly set.
 */
export const MANUAL_IMPORT_GUIDE_HEADER_LIMIT = 8 * 1024;

/** What a step the header has no room for says in the dialog. */
export const MANUAL_IMPORT_STEP_IN_README =
	"The README.txt in the ZIP has this step in full.";

/**
 * The steps as the header carries them, within
 * `MANUAL_IMPORT_GUIDE_HEADER_LIMIT`. Every step keeps its title, in order.
 * While the guide runs over, the longest step still carrying its text gives
 * it up for the line that points to the README, which always holds the guide
 * in full.
 */
export function encodeManualImportGuide(
	steps: readonly ManualImportStep[],
): string {
	const carried = [...steps];
	const encode = () => encodeURIComponent(JSON.stringify(carried));
	const longestFirst = steps
		.map((step, index) => ({
			index,
			length: encodeURIComponent(JSON.stringify(step.lines)).length,
		}))
		.sort((a, b) => b.length - a.length);
	let encoded = encode();
	for (const { index } of longestFirst) {
		if (encoded.length <= MANUAL_IMPORT_GUIDE_HEADER_LIMIT) break;
		carried[index] = { ...steps[index], lines: [MANUAL_IMPORT_STEP_IN_README] };
		encoded = encode();
	}
	return encoded;
}

function isManualImportStep(value: unknown): value is ManualImportStep {
	if (typeof value !== "object" || value === null) return false;
	const step = value as Record<string, unknown>;
	return (
		typeof step.kind === "string" &&
		STEP_KINDS.has(step.kind) &&
		typeof step.title === "string" &&
		Array.isArray(step.lines) &&
		step.lines.every((line) => typeof line === "string")
	);
}

/** Empty for a missing or unreadable header: the bytes already arrived, and the README holds the guide. */
export function decodeManualImportGuide(
	value: string | null,
): readonly ManualImportStep[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return Array.isArray(parsed) && parsed.every(isManualImportStep)
			? parsed
			: [];
	} catch {
		return [];
	}
}
