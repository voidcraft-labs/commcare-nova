/** Built-in worker readings, expressed in each existing authoring scope.
 * Forms read the worker record; record expressions read the session identity.
 * Keep the distinction visible without requiring authors to know either wire path.
 */
export const workerIdentityReadings = {
	workerId: {
		label: "Worker ID",
		meaning:
			"The worker running the app, including the selected Preview persona. This is not the case owner or the Nova member authorizing Preview.",
		formExpression: "#user/hq_user_id",
		recordExpression: "session('userid')",
	},
	loginName: {
		label: "Worker login name",
		meaning:
			"The worker's login name. Preview personas use their persona name. A login name is distinct from a person's display name.",
		formExpression: "#user/username",
		recordExpression: "session('username')",
	},
	displayName: {
		label: "Worker display name",
		meaning:
			"The worker's display name, falling back to their login name. Available through the worker record in forms.",
		formExpression: "#user/case_name",
	},
} as const;

/** HQ supplies these on both the worker case and the session. A location
 * assignment in Preview (including a disposable test) projects the same facts. */
export const workerPlaceReadings = {
	primaryPlace: {
		label: "Primary place",
		meaning:
			"The worker's primary assigned place. Empty without an assignment.",
		formExpression: "#user/commcare_location_id",
		recordExpression: "external-user('commcare_location_id')",
	},
	assignedPlaces: {
		label: "Assigned places",
		meaning:
			"All assigned place IDs, separated by spaces. This list is not a single record owner.",
		formExpression: "#user/commcare_location_ids",
		recordExpression: "external-user('commcare_location_ids')",
	},
	primarySharingGroup: {
		label: "Primary case-sharing group",
		meaning:
			"The primary place's case-sharing ID. Use this single value when the workflow assigns records to the worker's primary place. Empty without an assignment; address-book visibility alone does not assign a place or deliver records.",
		formExpression: "#user/commcare_primary_case_sharing_id",
		recordExpression: "external-user('commcare_primary_case_sharing_id')",
	},
} as const;

export function workerPlaceGuidance(): string {
	return `Assigned places are built-in worker information, not custom properties to add. Forms read the primary place with ${workerPlaceReadings.primaryPlace.formExpression}; record expressions use ${workerPlaceReadings.primaryPlace.recordExpression}. For an operation that assigns ownership to the worker's primary place, use ${workerPlaceReadings.primarySharingGroup.recordExpression}. These values are empty without a worker assignment. Saved persona assignments and disposable test assignments supply them in Preview; real deployment assignments supply them on devices. The worker-information read returns these readings and the all-places list. Form readings have the same worker-record requirement as identity readings.`;
}

export const workerFormIdentityRequirement =
	"Form worker readings use the worker's own CommCare record. The HQ project must include user cases and the worker must sync that record; otherwise reads can be blank. Preview supplies it but cannot establish target readiness. Record-scope session identity does not need that record.";

export function workerIdentityGuidance(): string {
	return `Worker identity is already available without adding custom worker information. In form expressions, ${workerIdentityReadings.workerId.formExpression} reads the current worker's ID, ${workerIdentityReadings.loginName.formExpression} their login name, and ${workerIdentityReadings.displayName.formExpression} their display name. In record expressions, use ${workerIdentityReadings.workerId.recordExpression} and ${workerIdentityReadings.loginName.recordExpression} for ID and login name; session() is not a form function. These are the worker running the app, including a selected Preview persona, not the Nova member authorizing Preview or a case's owner. Save them only when a business event needs lasting actor history, such as who approved a request. ${workerFormIdentityRequirement}`;
}
