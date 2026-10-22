import type { Term } from "@/lib/domain/expression/types";
import { userPropertiesOf } from "@/lib/domain/users";
import { asUuid } from "@/lib/domain/uuid";
import { userPropertySlugVerdict } from "../validator/userPropertySlug";
import type { FormParseScope } from "./formParseScope";

const NO_SLUGS: ReadonlySet<string> = new Set();

/** One exact, case-insensitively unique authored worker property becomes an
 * identity. External or reserved names retain their declared name. */
export function formUserProperty(
	scope: Pick<FormParseScope, "doc">,
	slug: string,
	source?: "worker-record",
): Term {
	const matches = Object.entries(userPropertiesOf(scope.doc)).filter(
		([, property]) => property.slug.toLowerCase() === slug.toLowerCase(),
	);
	const own =
		matches.length === 1 &&
		matches[0][1].slug === slug &&
		userPropertySlugVerdict(slug, NO_SLUGS).ok
			? asUuid(matches[0][0])
			: undefined;
	const provenance = source === undefined ? {} : { source };
	return own === undefined
		? { kind: "session-user", field: slug, ...provenance }
		: { kind: "session-user-property", userPropertyUuid: own, ...provenance };
}
