import {
	type LookupPathNameIssue,
	lookupPathNameIssue,
} from "@/lib/lookup/pathNames";
import { defineClaims, refuse } from "./claims";

const unreadable =
	"expressions-and-data/tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any";

const claims = defineClaims("lookup-names", {
	unreadableTag: refuse(unreadable, "lookup-model:LookupTable.tag"),
	unreadableColumn: refuse(unreadable, "lookup-model:TypeField.name"),
	undeclared: refuse(
		"expressions-and-data/lookup-table-instance-undiscovered-in-suite",
		"lookup-model:LookupTable.tag",
	),
	hqUnreadableTag: refuse(
		"expressions-and-data/non-ascii-lookup-name-in-a-condition-hq-checks",
		"lookup-model:LookupTable.tag",
	),
	hqUnreadableColumn: refuse(
		"expressions-and-data/non-ascii-lookup-name-in-a-condition-hq-checks",
		"lookup-model:TypeField.name",
	),
	formReadTag: refuse(
		"expressions-and-data/non-ascii-lookup-name-a-form-reads",
		"lookup-model:LookupTable.tag",
	),
	interpolated: refuse(
		"expressions-and-data/dotted-column-interpolated-in-suite",
		"lookup-model:TypeField.name",
	),
});

export function undiscoveredLookupName(tag: string) {
	return { name: tag, claim: claims.undeclared };
}

export function lookupNameRefusal(
	name: string,
	registrySlot: string,
	part: "tag" | "column",
) {
	// The final declaration is chosen after the whole document is assembled.
	// Only a path which cannot be built for any worker is refused here.
	const issue = lookupPathNameIssue(name, registrySlot, part, ["web-apps"]);
	if (issue === null) return;
	return { name, issue, claim: nameClaim(issue, part) };
}

function nameClaim(issue: LookupPathNameIssue, part: "tag" | "column") {
	switch (issue) {
		case "unreadable-name":
			return part === "tag" ? claims.unreadableTag : claims.unreadableColumn;
		case "undeclared-instance":
			return claims.undeclared;
		case "interpolated-period":
			return claims.interpolated;
		case "hq-unreadable-name":
			return part === "tag"
				? claims.hqUnreadableTag
				: claims.hqUnreadableColumn;
		case "form-builder-unreadable-name":
			// Only a tag a form reads is refused there (`pathNames.ts`).
			return claims.formReadTag;
	}
}
