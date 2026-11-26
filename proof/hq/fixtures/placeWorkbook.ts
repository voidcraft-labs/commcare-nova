/** Builds the synthetic organization workbook passed to HQ's native importer.
 * The update addresses the recorded destination UUID from its own v1 list. */
import { readFileSync } from "node:fs";
import type { HqLocation } from "@/lib/commcare/hq/locations";
import { placeIdWorkbookMembers } from "@/lib/commcare/hq/placeWorkbook";
export async function proofPlaceWorkbook() {
	const fixture = JSON.parse(
		readFileSync("proof/hq-reads/places/locations-v1.json", "utf8"),
	);
	const rows = JSON.parse(fixture.body).objects as {
		site_code: string;
		location_id: string;
		name: string;
	}[];
	const child = rows.find((row) => row.site_code === "north_clinic"),
		parent = rows.find((row) => row.site_code === "north");
	if (!child || !parent)
		throw Error("The native place fixture has no site to update.");
	const values = { phone: "01923", local_note: "ward α" };
	const place: HqLocation = {
		locationId: child.location_id,
		siteCode: child.site_code,
		name: child.name,
		parentLocationId: parent.location_id,
		locationTypeCode: "district",
		latitude: "1.2300000000",
		longitude: null,
		values,
		observation: {
			externalId: null,
			nameIsNull: false,
			wire: Object.fromEntries(
				Object.entries(values).map(([key, text]) => [
					key,
					JSON.stringify(text),
				]),
			),
			worker: values,
		},
	};
	const common = {
		administrative: false,
		sharesCases: false,
		viewDescendants: false,
	};
	const [member] = placeIdWorkbookMembers(
		"nova-proof",
		[
			{ ...common, id: "1", code: "region", name: "Region", parentCode: null },
			{
				...common,
				id: "2",
				code: "district",
				name: "District",
				parentCode: "region",
			},
		],
		[{ place, externalId: "EXT-α-01", parentCode: parent.site_code }],
	);
	const chunks: Buffer[] = [];
	for await (const chunk of member.open()) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}
