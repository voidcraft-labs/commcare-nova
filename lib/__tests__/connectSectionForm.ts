import { testUuid } from "@/__tests__/helpers/uuid";
import { NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { buildDoc, f } from "./docHelpers";

/** One Learn form across the section planner, native round trip and signed Builder.
 * Every activity has its own receiver identity, including the one inside a page. */
export function connectSectionForm(appId: string, lastLabel = "Next step") {
	const uuid = (id: string) => testUuid(`${appId}/${id}`);
	const lesson = (id: string, name: string) =>
		f({
			uuid: uuid(id),
			id,
			kind: "connect_activity",
			activity: {
				kind: "learning-module",
				name,
				description: name,
				estimatedHours: 1,
			},
		});
	const page = (id: string, title: string, children: ReturnType<typeof f>[]) =>
		f({
			uuid: uuid(id),
			id,
			kind: "section",
			label: proseText(title),
			children,
		});
	const answer = (id: string, title: string) =>
		f({ uuid: uuid(id), id, kind: "text", label: proseText(title) });
	return buildDoc({
		appId,
		appName: "Community learning",
		connectRoles: ["learn"],
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				uuid: uuid("menu"),
				name: "Training",
				forms: [
					{
						uuid: uuid("form"),
						type: "survey",
						name: "Lesson one",
						fields: [
							lesson("lesson_one", "Introduction"),
							page("practice", "Practice", [
								answer("reflection", "Reflection"),
								lesson("rehearsal", "Rehearsal"),
							]),
							lesson("review", "Review"),
							page("follow_up", "Follow up", [answer("next_step", lastLabel)]),
							lesson("completion", "Completion"),
						],
					},
				],
			},
		],
	});
}
