import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, proseText } from "@/lib/domain";

export const LOCALIZATION_SEED = {
	appName: "Smoke language editing",
	moduleUuid: asUuid("018faa00-aaaa-7000-8000-000000000001"),
	formUuid: asUuid("018faa00-aaaa-7000-8000-000000000002"),
	fieldUuid: asUuid("018faa00-aaaa-7000-8000-000000000003"),
};

/** An English survey with one protected worker reference. The browser authors
 * the target language through the same picker and commit path as a person. */
export function buildLocalizationBlueprint(appId: string) {
	return buildDoc({
		appId,
		appName: LOCALIZATION_SEED.appName,
		modules: [
			{
				uuid: LOCALIZATION_SEED.moduleUuid,
				name: "Intake",
				forms: [
					{
						uuid: LOCALIZATION_SEED.formUuid,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								uuid: LOCALIZATION_SEED.fieldUuid,
								id: "client_name",
								kind: "text",
								label: proseText("Client name"),
								hint: {
									parts: [
										{ kind: "text", text: "Worker " },
										{ kind: "user-ref", property: "username" },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
}
