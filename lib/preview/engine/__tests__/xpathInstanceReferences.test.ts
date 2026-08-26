import { describe, expect, it } from "vitest";
import {
	xpathReferencesCaseDatabaseHashtag,
	xpathReferencesInstance,
} from "../xpathInstanceReferences";

describe("xpathReferencesInstance", () => {
	it.each([
		"instance('casedb')/casedb/case",
		'instance("casedb")/casedb/case',
		"instance ( 'casedb' ) /casedb/case",
	])("recognizes structural casedb references in %s", (source) => {
		expect(xpathReferencesInstance(source, "casedb")).toBe(true);
	});

	it.each([
		`"instance('casedb')"`,
		"concat(\"instance('casedb')\", /data/name)",
		"instance('commcaresession')/session/context/userid",
		"some-instance('casedb')",
		"instance(/data/instance_id)",
	])("does not infer a casedb reference from %s", (source) => {
		expect(xpathReferencesInstance(source, "casedb")).toBe(false);
	});
});

describe("xpathReferencesCaseDatabaseHashtag", () => {
	it.each(["#patient/status", "count(#user/role)"])(
		"recognizes the structural casedb hashtag in %s",
		(source) => {
			expect(xpathReferencesCaseDatabaseHashtag(source)).toBe(true);
		},
	);

	it.each([
		"#form/status",
		`"#patient/status"`,
		"concat('#user/role', #form/name)",
	])("does not infer a casedb load from %s", (source) => {
		expect(xpathReferencesCaseDatabaseHashtag(source)).toBe(false);
	});
});
