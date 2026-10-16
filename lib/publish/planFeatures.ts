/**
 * Public vocabulary for what a CommCare HQ plan, and a project space's own
 * settings, must give an app that Nova cannot read with an API key.
 *
 * Safe for browser, HTTP and MCP consumers. No API key reads a project
 * space's plan or its privileges, so a publish asks the person to confirm
 * each one the app needs, once per project space, and records who did. This
 * module names each plan feature as a person looks for it on CommCare HQ's
 * subscription page and says what goes wrong without it; the crossing from
 * HQ's privilege slugs to these ids lives in `lib/commcare/planPrivileges.ts`,
 * and no HQ slug enters this vocabulary.
 *
 * Every `plans` literal is the current plans whose feature list carries the
 * feature, as the list names them. `lib/commcare/__tests__/planPrivileges.test.ts`
 * holds each to `lib/commcare/planPrivilegePlans.json`, and the proof lane
 * holds that file to HQ's own plan lists.
 */

export type PlanFeatureId =
	| "worker-records"
	| "lookup-tables"
	| "child-cases"
	| "form-links"
	| "advanced-case-actions"
	| "organization"
	| "data-forwarding";

export interface PlanFeatureDefinition {
	readonly id: PlanFeatureId;
	/** CommCare HQ's own name for the feature where it has one. */
	readonly label: string;
	/** The current plans that include it, as a sentence fragment. */
	readonly plans: string;
	/** What happens without it, in one or two sentences. */
	readonly consequence: string;
}

/** In the order every surface lists them. */
export const PLAN_FEATURES: Readonly<
	Record<PlanFeatureId, PlanFeatureDefinition>
> = {
	"worker-records": {
		id: "worker-records",
		label: "Worker records (user cases)",
		plans: "Pro, Advanced and Enterprise",
		consequence:
			"Without it, CommCare HQ can't build a form that saves to the worker's record, and what a form reads from it is blank.",
	},
	"lookup-tables": {
		id: "lookup-tables",
		label: "Lookup Tables",
		plans: "Standard, Pro, Advanced and Enterprise",
		consequence:
			"Without it, CommCare HQ turns away the tables Nova sends and can't build a form that reads one, and its form builder shows an error on each question whose choices come from cases.",
	},
	"child-cases": {
		id: "child-cases",
		label: "Child Cases",
		plans: "Pro, Advanced and Enterprise",
		consequence:
			"Without it, nobody can add, change or remove this form's child cases in CommCare HQ. The app itself runs the same.",
	},
	"form-links": {
		id: "form-links",
		label: "Link to other forms in End of Form Navigation",
		plans: "Standard, Pro, Advanced and Enterprise",
		consequence:
			"Without it, nobody can change this form's links in CommCare HQ. The links Nova wrote stay.",
	},
	"advanced-case-actions": {
		id: "advanced-case-actions",
		label: "Save to Case",
		plans: "Advanced and Enterprise",
		consequence:
			"Without it, saving this form in CommCare HQ's form builder removes what ties its case changes to a case.",
	},
	organization: {
		id: "organization",
		label: "Locations",
		plans: "Advanced and Enterprise",
		consequence:
			"Without it, forms that read your places don't open on the phone, and CommCare HQ turns away the places Nova sends.",
	},
	"data-forwarding": {
		id: "data-forwarding",
		label: "Data Forwarding",
		plans: "Pro, Advanced and Enterprise",
		consequence:
			"Without it, CommCare HQ takes this app's forms and sends none of them to CommCare Connect, so no learning or delivery is recorded there.",
	},
};

/** Every plan feature id, in `PLAN_FEATURES`' order. */
export const PLAN_FEATURE_IDS = Object.keys(
	PLAN_FEATURES,
) as readonly PlanFeatureId[];

export function isPlanFeatureId(value: unknown): value is PlanFeatureId {
	return (
		typeof value === "string" &&
		(PLAN_FEATURE_IDS as readonly string[]).includes(value)
	);
}

/** A plan feature this app needs, with why: one sentence per form, then the publish's own. */
export interface PlanFeatureUse extends PlanFeatureDefinition {
	readonly reasons: readonly string[];
}

export function planFeatureUse(
	id: PlanFeatureId,
	reasons: readonly string[],
): PlanFeatureUse {
	return { ...PLAN_FEATURES[id], reasons };
}

/** The checkbox each plan feature row offers. */
export const PLAN_FEATURE_CONFIRM_LABEL = "This project space has it";

/**
 * A project-space setting a publish asks about beside the plan features:
 * one no plan decides and no API reads. Each carries the copy a dialog, the
 * deployment card and the HQ import guide read from one place.
 */
export interface ProjectSpaceSettingConfirmation {
	readonly label: string;
	readonly consequence: string;
	/** The question a dialog asks, with the project space's name in place. */
	readonly question: (space: string) => string;
	/** The checkbox that answers yes. */
	readonly confirmLabel: string;
	/** What to do where the answer is no. */
	readonly whereMissing: string;
}

/**
 * Whether the project space still sends its flat location list to workers.
 * Every app carries `project_default`, so phones and Web Apps both take the
 * list by the project space's own setting, which no API reads.
 */
export const FLAT_LOCATION_FIXTURE: ProjectSpaceSettingConfirmation = {
	label: "The flat location list",
	consequence:
		"Without it, forms that read your places don't work: on phones they don't open, and in Web Apps they save no place to a case.",
	question: (space) =>
		`This app reads the places in your organization, on phones and in Web Apps, and its forms that do can't work without them. Does “${space}” still send its location list to workers? It does unless someone turned that off in the project space's Location Fixture settings.`,
	confirmLabel: "It still does",
	whereMissing:
		"Turning the flat location list back on is done on the project space's Location Fixture page, or through Dimagi Support where the space has no such page. It changes what every app there syncs.",
};

/**
 * Whether the project space holds a forwarder that sends this app's forms to
 * CommCare Connect. A signed-in admin makes one on CommCare HQ's Data
 * Forwarding page, which no API key reads.
 */
export const CONNECT_FORWARDER: ProjectSpaceSettingConfirmation = {
	label: "A Connect forwarder",
	consequence:
		"Without it, CommCare HQ sends none of this app's forms to CommCare Connect.",
	question: (space) =>
		`This app's forms reach CommCare Connect only through a forwarder in “${space}”. Does it have one, set up on CommCare HQ's Data Forwarding page as Forward Form Metadata to Commcare Connect?`,
	confirmLabel: "It does",
	whereMissing:
		"A project space admin can add it on CommCare HQ's Data Forwarding page, choosing Forward Form Metadata to Commcare Connect with the connection CommCare Connect gives them.",
};

/** Whether a confirmation is on record for the target, as a check reports it. */
export type PlanFeatureCheckState = "confirmed" | "needs_confirmation";

/**
 * One plan feature as the pre-publish check reports it for a target: the
 * definition, why this app needs it, and whether a person confirmed it
 * there. `confirmed_by` is the member's display name, never a user id.
 */
export interface PlanFeatureCheck extends PlanFeatureUse {
	readonly state: PlanFeatureCheckState;
	readonly confirmed_by?: string;
	readonly confirmed_at?: string;
}

/** A project-space setting as the pre-publish check reports it. */
export interface ProjectSpaceSettingCheck {
	readonly label: string;
	readonly consequence: string;
	readonly reasons: readonly string[];
	readonly state: PlanFeatureCheckState;
	readonly confirmed_by?: string;
	readonly confirmed_at?: string;
}

/**
 * What the app on a project space says where Web Apps does not offer it.
 * HQ sets that from the plan when an upload creates the app, and Nova never
 * writes it, so this is said, never asked.
 */
export function webAppsOffText(space: string): string {
	return `This app isn't in Web Apps on “${space}”. CommCare HQ turns Web Apps on for a new app only where the project space's plan includes it. Once the plan does, you can turn it on in this app's settings in CommCare HQ.`;
}

/**
 * What a publish offers for an app's logo, which it never sends: HQ's own
 * uploader writes the record a logo needs there. Read verbatim by the
 * publish dialog, the setup artifact's `logo` section and MCP.
 */
export const LOGO_UPLOAD_STEP_TEXT =
	"Your app's logo isn't sent with the app. To show it in apps built on CommCare HQ, you can download it here and add it in this app's settings there. That takes a plan with the Custom CommCare Logo Uploader (Advanced or Enterprise); on other plans, apps built on CommCare HQ carry no logo.";
