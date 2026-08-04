import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type BlueprintDoc,
	type OrganizationLevel,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import {
	fixedLocationOwnerIssue,
	reverseLocationOwnerIssue,
} from "../ownerTargetVerdicts";

const ROOT = testUuid("depth-root");
const SOURCE = testUuid("depth-source");
const DESTINATION = testUuid("depth-destination");
const SIBLING = testUuid("depth-sibling");
const SIBLING_LEAF = testUuid("depth-sibling-leaf");
const ROOT_PLACE = testUuid("depth-root-place");
const SOURCE_PLACE = testUuid("depth-source-place");
const DESTINATION_PLACE = testUuid("depth-destination-place");
const PERSONA = testUuid("depth-persona");

function level(
	uuid: string,
	name: string,
	parentLevelUuid: string | undefined,
	caseFlow: OrganizationLevel["caseFlow"],
): OrganizationLevel {
	return {
		uuid: asUuid(uuid),
		code: name.toLowerCase(),
		name,
		...(parentLevelUuid === undefined
			? {}
			: { parentLevelUuid: asUuid(parentLevelUuid) }),
		caseFlow,
		addressBook: { reach: "own-branch" },
	};
}

function location(
	id: string,
	levelUuid: string,
	parentId: string | null,
	name: string,
): StoredLocation {
	return {
		id: asUuid(id),
		levelUuid: asUuid(levelUuid),
		parentId: parentId === null ? null : asUuid(parentId),
		siteCode: name.toLowerCase(),
		name,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: id,
	};
}

const rows = [
	location(ROOT_PLACE, ROOT, null, "Root"),
	location(SOURCE_PLACE, SOURCE, ROOT_PLACE, "Source"),
	location(DESTINATION_PLACE, DESTINATION, SOURCE_PLACE, "Destination"),
];

function depthDoc(): BlueprintDoc {
	const doc = buildDoc() as BlueprintDoc;
	doc.organizationLevels = {
		[ROOT]: level(ROOT, "Root", undefined, {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		}),
		[SOURCE]: level(SOURCE, "Source", ROOT, {
			workers: "none",
			ownsCases: true,
		}),
		[DESTINATION]: level(DESTINATION, "Destination", SOURCE, {
			workers: "none",
			ownsCases: true,
		}),
		[SIBLING]: level(SIBLING, "Sibling", ROOT, {
			workers: "none",
			ownsCases: false,
		}),
		[SIBLING_LEAF]: level(SIBLING_LEAF, "SiblingLeaf", SIBLING, {
			workers: "none",
			ownsCases: false,
		}),
	};
	doc.organizationLevelOrder = [
		ROOT,
		SOURCE,
		DESTINATION,
		SIBLING,
		SIBLING_LEAF,
	];
	doc.personas = {
		[PERSONA]: {
			uuid: asUuid(PERSONA),
			name: "Asha",
			locations: { primaryUuid: asUuid(ROOT_PLACE) },
		},
	};
	doc.personaOrder = [asUuid(PERSONA)];
	return doc;
}

describe("owner target depth ceilings", () => {
	it("includes a descendant at the depth named by a sibling level branch", () => {
		const doc = depthDoc();
		doc.organizationLevels = {
			...doc.organizationLevels,
			[ROOT]: {
				...(doc.organizationLevels?.[ROOT] as OrganizationLevel),
				addressBook: {
					reach: "own-branch",
					downToLevelUuid: asUuid(SIBLING_LEAF),
				},
			},
		};

		expect(
			fixedLocationOwnerIssue(doc, rows, DESTINATION_PLACE),
		).toBeUndefined();
	});

	it("uses actual place depth when a place skips an authored level", () => {
		const doc = depthDoc();
		doc.organizationLevels = {
			...doc.organizationLevels,
			[ROOT]: {
				...(doc.organizationLevels?.[ROOT] as OrganizationLevel),
				addressBook: {
					reach: "own-branch",
					downToLevelUuid: asUuid(SIBLING),
				},
			},
		};
		const raggedRows = rows.map((row) =>
			row.id === DESTINATION_PLACE ? { ...row, parentId: ROOT_PLACE } : row,
		);

		expect(
			fixedLocationOwnerIssue(doc, raggedRows, DESTINATION_PLACE),
		).toBeUndefined();
	});

	it("applies descendant-case caps by absolute depth across branches", () => {
		const doc = depthDoc();
		doc.organizationLevels = {
			...doc.organizationLevels,
			[ROOT]: {
				...(doc.organizationLevels?.[ROOT] as OrganizationLevel),
				caseFlow: {
					workers: "assigned",
					ownsCases: true,
					descendantCases: {
						kind: "down-to",
						levelUuid: asUuid(SIBLING),
					},
				},
				addressBook: {
					reach: "own-branch",
					downToLevelUuid: asUuid(SIBLING),
				},
			},
		};

		expect(reverseLocationOwnerIssue(doc, rows, DESTINATION)).toMatch(
			/outside Asha's address book/,
		);
	});
});
