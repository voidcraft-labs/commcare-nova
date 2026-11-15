/**
 * Which worker-data keys a read of the session may find absent in Preview
 * and still read on a device.
 *
 * A device's session holds exactly the keys HQ's restore writes: one for each
 * field the project space defines (`''` where the worker has none) and the
 * built-in keys it gives that worker (`user_data.py::UserData.to_dict`,
 * `models.py::get_user_session_data`). Core refuses a read of any other key
 * (`DataInstance.hasTemplatePath`, then `XPathNodeset.unpack`). The project
 * space's own key is held by every device, but Preview knows it only once the
 * app is published to one project space (`identity.ts::frameworkSessionKeys`),
 * so while Preview leaves it out a read of it is blank, never refused. Every
 * other key Preview leaves out is one the worker's device lacks.
 */

import { BUILT_IN_USER_PROPERTIES } from "@/lib/domain";

/** The worker-data keys every device holds that Preview may not know yet. */
export const PREVIEW_UNKNOWN_WORKER_KEYS: ReadonlySet<string> = new Set(
	BUILT_IN_USER_PROPERTIES.filter(
		(property) => property.availability === "needs-deployment-target",
	).map((property) => property.slug),
);
