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

export const workerFormIdentityRequirement =
	"Form worker readings use the worker's own CommCare record. The HQ project must include user cases and the worker must sync that record; otherwise reads can be blank. Preview supplies it but cannot establish target readiness. Record-scope session identity does not need that record.";

export function workerIdentityGuidance(): string {
	return `Worker identity is already available without adding custom worker information. In form expressions, ${workerIdentityReadings.workerId.formExpression} reads the current worker's ID, ${workerIdentityReadings.loginName.formExpression} their login name, and ${workerIdentityReadings.displayName.formExpression} their display name. In record expressions, use ${workerIdentityReadings.workerId.recordExpression} and ${workerIdentityReadings.loginName.recordExpression} for ID and login name; session() is not a form function. These are the worker running the app, including a selected Preview persona, not the Nova member authorizing Preview or a case's owner. Save them only when a business event needs lasting actor history, such as who approved a request. ${workerFormIdentityRequirement}`;
}
