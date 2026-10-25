import { BUILT_IN_USER_PROPERTIES, type UserProperty } from "@/lib/domain";
import type {
	SessionContextField,
	SessionUserPropertyRef,
	SessionUserRef,
} from "@/lib/domain/expression";

/** Every session context field, offered and shown by its own name. */
const PRESENTATIONS = {
	userid: { field: "userid", label: "Current user's ID" },
	username: { field: "username", label: "Current user's name" },
	deviceid: { field: "deviceid", label: "This device's ID" },
	appversion: { field: "appversion", label: "App version" },
	drift: { field: "drift", label: "Device clock offset" },
	window_width: { field: "window_width", label: "Window width" },
	applanguage: { field: "applanguage", label: "App language" },
} as const satisfies Record<
	SessionContextField,
	{ field: SessionContextField; label: string }
>;

export function sessionContextPresentation<Field extends SessionContextField>(
	field: Field,
) {
	return PRESENTATIONS[field];
}

export const SESSION_CONTEXT_CHOICES = Object.values(PRESENTATIONS);

export type SessionUserReference = SessionUserRef | SessionUserPropertyRef;

/** The picker authors session data. A retained worker-record read has different
 * evaluation semantics and stays named and read-only until it has an editor. */
export function sessionUserPresentation<Reference extends SessionUserReference>(
	reference: Reference,
	userProperties: readonly UserProperty[],
) {
	const propertyLabel =
		reference.kind === "session-user"
			? (BUILT_IN_USER_PROPERTIES.find(
					(property) => property.slug === reference.field,
				)?.label ?? reference.field)
			: (userProperties.find(
					(property) => property.uuid === reference.userPropertyUuid,
				)?.label ?? "Unavailable worker information");
	const kind = reference.source === "worker-record" ? "preserved" : "editable";
	return {
		kind,
		reference,
		label:
			kind === "preserved"
				? `${propertyLabel} from the worker record`
				: propertyLabel,
	};
}
