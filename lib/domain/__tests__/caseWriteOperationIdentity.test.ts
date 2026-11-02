/**
 * The derived identities of the operations made from a form's field
 * writes. Each UUID is checked against an RFC 4122 version 5 computation
 * written here over Node's SHA-1, so a changed namespace, version string or
 * name spelling (which would make a dry run and its execution name
 * different operations, or move every migrated document's operation ids)
 * fails here rather than in the cutover.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CASE_WRITE_OPERATION_NAMESPACE_UUID,
	type CaseWriteOperationUnit,
	caseWriteOperationUuid,
} from "@/lib/domain/caseWriteOperationIdentity";
import { asUuid, type Uuid } from "@/lib/domain/uuid";

const APP = "case-writes-app";
const FORM = asUuid("5a6e0c2f-8d0b-4c63-9a52-2f4f3c1b7e10");
const REPEAT = asUuid("0f2d7b44-1c39-4f0e-b8a1-6d5e9c3a2b71");

/** RFC 4122 §4.3: SHA-1 over the namespace's bytes then the name's UTF-8. */
function rfc4122v5(name: string, namespace: string): string {
	const hash = createHash("sha1")
		.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
		.update(Buffer.from(name, "utf8"))
		.digest();
	const bytes = hash.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("caseWriteOperationUuid", () => {
	it("holds the namespace the plan fixed", () => {
		expect(CASE_WRITE_OPERATION_NAMESPACE_UUID).toBe(
			"2d4b57b2-18ff-430a-b230-8eec087cdfc1",
		);
	});

	it("names each unit by the JSON array of version, app, form and unit", () => {
		const units: CaseWriteOperationUnit[] = [
			"own",
			"usercase",
			`child:visit:${REPEAT}`,
			"extension:household:root",
		];
		for (const unit of units) {
			expect(caseWriteOperationUuid(APP, FORM, unit)).toBe(
				rfc4122v5(
					JSON.stringify(["nova-case-writes-op-v1", APP, FORM, unit]),
					CASE_WRITE_OPERATION_NAMESPACE_UUID,
				),
			);
		}
	});

	it("names the same operation each time it is planned, and another for another app, form or unit", () => {
		const first = caseWriteOperationUuid(APP, FORM, "own");
		expect(caseWriteOperationUuid(APP, FORM, "own")).toBe(first);
		const names = new Set([
			first,
			caseWriteOperationUuid("another-app", FORM, "own"),
			caseWriteOperationUuid(APP, REPEAT, "own"),
			caseWriteOperationUuid(APP, FORM, "usercase"),
			caseWriteOperationUuid(APP, FORM, "child:visit:root"),
			caseWriteOperationUuid(APP, FORM, "extension:visit:root"),
		]);
		expect(names.size).toBe(6);
	});

	it("appends the attempt after the first, so a taken UUID is stepped around", () => {
		expect(caseWriteOperationUuid(APP, FORM, "own", 0)).toBe(
			caseWriteOperationUuid(APP, FORM, "own"),
		);
		expect(caseWriteOperationUuid(APP, FORM, "own", 1)).toBe(
			rfc4122v5(
				JSON.stringify(["nova-case-writes-op-v1", APP, FORM, "own", 1]),
				CASE_WRITE_OPERATION_NAMESPACE_UUID,
			),
		);
		// The planner takes the first attempt no entity of the document holds.
		const taken = new Set<Uuid>([
			caseWriteOperationUuid(APP, FORM, "own", 0),
			caseWriteOperationUuid(APP, FORM, "own", 1),
		]);
		let attempt = 0;
		while (taken.has(caseWriteOperationUuid(APP, FORM, "own", attempt))) {
			attempt += 1;
		}
		expect(attempt).toBe(2);
		expect(taken.has(caseWriteOperationUuid(APP, FORM, "own", attempt))).toBe(
			false,
		);
	});
});
