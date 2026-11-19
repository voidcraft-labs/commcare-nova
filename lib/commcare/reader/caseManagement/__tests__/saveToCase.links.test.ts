/**
 * Each link and unlink of a Save to Case block, counted in the claim log.
 *
 * Contract: every `index/<name>` a block Nova holds carries is claimed under
 * the link entry at that element, whatever names its target (the menu's
 * chosen case, another operation of the form, an expression, or nothing, an
 * unlink), so the claim log counts the entry wherever a reading meets a link.
 * The failure it catches: a link counted only where an expression names its
 * target, the one slot the expression stage registers, so a link to the
 * chosen case or to another operation, and an unlink, count nothing.
 */
import { describe, expect, it } from "vitest";
import { saveToCaseShapesApp } from "../../../../../proof/targeted/documents/saveToCaseShapes";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const LINK =
	"questions/savetocase-link-index-name-child-extension-and-unlink-empty";

describe("a Save to Case block's links", () => {
	it("are each claimed under the link entry at their index element", async () => {
		const doc = saveToCaseShapesApp();
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
			{ claims: "full" },
		);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		const links = [...outcome.claims.records()].filter(
			(record) => record.entry === LINK,
		);
		// The member's link to the household the menu chose, which no expression names.
		const CASE = "{http://commcarehq.org/case/transaction/v2}";
		expect(
			links.some((record) =>
				record.where.endsWith(`${CASE}index[1]/${CASE}parent[1]`),
			),
		).toBe(true);
	});
});
