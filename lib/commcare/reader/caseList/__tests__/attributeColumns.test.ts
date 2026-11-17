/**
 * The canonical row `calculated-attribute-columns-are-plain`: a calculated
 * column that reads one of the case's attributes alone and the plain column
 * over that attribute print one column into CommCare HQ's source, which the
 * reader reads.
 *
 * Contract: both members' HQ applications are equal, the row turns the
 * calculated member into the plain one and is a fixed point on its result,
 * and a reading of the calculated member's export gives the plain column.
 *
 * Plausible failure: a row that moves a column to a spelling HQ's source
 * holds otherwise, or a reading that keeps the calculated column.
 */

import { expect, it } from "vitest";
import { calculatedColumn, plainColumn } from "@/lib/domain";
import { prop, term } from "@/lib/domain/expression/builders";
import { expandDoc } from "../../../expander";
import { calculatedAttributeColumnsArePlain } from "../columns";
import { patients, uuid } from "./fixtures";

it("prints a calculated column over the owner as the plain column over it", () => {
	const calculated = patients([
		plainColumn(uuid(1), "case_name", "Name"),
		calculatedColumn(uuid(2), "Owner", term(prop("patient", "owner_id"))),
	]);
	const returned = calculatedAttributeColumnsArePlain(calculated);
	expect(returned).not.toEqual(calculated);
	const column = Object.values(returned.modules)[0]?.caseListConfig?.columns[1];
	expect(column).toMatchObject({ kind: "plain", field: "owner_id" });
	const application = (doc: typeof calculated) => {
		const { _attachments: _forms, ...rest } = expandDoc(doc) as unknown as {
			_attachments: unknown;
		};
		return rest;
	};
	expect(application(returned)).toEqual(application(calculated));
	expect(calculatedAttributeColumnsArePlain(returned)).toEqual(returned);
});
