export const SMOKE_TEXT = {
	userName: "Smoke Test User",
	viewerUserName: "Smoke Test Viewer",
	openAppName: "Smoke — Open Me",
	organizationAppName: "Smoke — Organization",
	deleteAppName: "Smoke — Delete Me",
	/** Cross-Project move journey: one app plus a second Project the seeded user
	 *  also owns, so the spec drives a real move between two governed places. */
	moveAppName: "Smoke — Move Me",
	moveProjectName: "Smoke Destination",
	/** Module-bearing app with a settled conversation — the smoke asserts the
	 *  transcript hydrates into the docked chat on load, lists in the
	 *  Conversations view, and survives a New chat → reopen round trip. */
	threadsAppName: "Smoke — Conversations",
	threadUserText: "Smoke: build a visit tracker",
	threadAssistantText: "Smoke: the visit tracker is ready.",
	olderThreadUserText: "Smoke: add an intake notes field",
	olderThreadAssistantText: "Smoke: the intake notes field is ready.",
	/** Module-bearing app for chat-scroll behavior: a tall settled conversation
	 *  (opens on load) plus a tall conversation paused on a waiting two-question
	 *  askQuestions card. Its sends are network-stubbed in the spec, so the
	 *  fixture never risks a model call. */
	scrollAppName: "Smoke — Scroll",
	scrollThreadUserText: "Smoke: tune the follow-up schedule",
	scrollThreadAssistantText: "Smoke: the follow-up schedule is tuned.",
	scrollQuestionThreadUserText: "Smoke: reshape the referral flow",
	scrollQuestionHeader: "Referral flow details",
	scrollQuestionOneText: "Who initiates a referral?",
	scrollQuestionTwoText: "When should a referral close?",
	scrollQuestionFinalOption: "After the visit is logged",
	/** A real sequence-one app activated by a completely scripted chat stream.
	 * The browser test exercises the design/build UI without reaching a model. */
	designBuildAppName: "Smoke — Scripted Design Build",
} as const;
