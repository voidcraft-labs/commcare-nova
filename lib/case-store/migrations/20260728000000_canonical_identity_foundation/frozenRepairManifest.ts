/**
 * Content-free, closed repair manifest for the production snapshot observed
 * before the canonical identity cutover. This is not a reusable repair
 * language: cardinalities, app/row identities, source bytes, and replacements
 * are all pinned. Any drift blocks.
 */

export const CANONICAL_IDENTITY_REPAIR_VERSION =
	"20260728000000-canonical-identity-repair-v2";

export interface FrozenThreadAttachmentRepairTarget {
	readonly messageIndex: number;
	readonly attachmentIndex: number;
	readonly assetId: string;
	readonly attachmentText: string;
	readonly attachmentDigest: string;
	readonly assetDisposition: "missing" | "foreign-project";
	readonly assetProjectId?: string;
	readonly assetRowDigest?: string;
}

export interface FrozenThreadAttachmentRepair {
	readonly appId: string;
	readonly appProjectId: string;
	readonly appRowDigest: string;
	readonly threadId: string;
	readonly sourceMessagesDigest: string;
	readonly sourceRowDigest: string;
	readonly resultMessagesDigest: string;
	readonly resultRowDigest: string;
	readonly targets: readonly FrozenThreadAttachmentRepairTarget[];
}

/**
 * Exact plaintext selectors and source/result digests captured in one
 * REPEATABLE READ, READ ONLY production snapshot (`1629016:1629016:`).
 * The repair keeps every message byte and removes only these thirteen strict
 * `messages[*].metadata.attachments[*]` objects. The deployment identity must
 * re-prove these bytes under the final quiescent lock before writing.
 */
export const FROZEN_THREAD_ATTACHMENT_REPAIRS = [
	{
		appId: "7iWzNHulL12GBrr81hAc",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"df0168629c4b5e8720ee97dc1c1d6905744f7bce9fb717e18a115a3f118c8450",
		threadId: "4aa09b2f-5d12-4607-93a2-d3eff57da278",
		sourceMessagesDigest:
			"7f622a32306a3afcddfdcdba775f88675b7bc82de7ba1d9836a254445efec036",
		sourceRowDigest:
			"168ac0e0f1a558b918f6da69d86484f6eca70dcc2e115eb6db7d35b78d99e755",
		resultMessagesDigest:
			"ba71bd5b06e113183b149aad26de68581d3f60811f48a51bb4eed9a8c9c71133",
		resultRowDigest:
			"67ffbe2c29a801cd73f203609486ea7794ed92a2c2f6c4141e50dbbc8d8aabfd",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "ec81f880-12a4-421b-8594-266fda2fc65e",
				attachmentText: `{"kind": "text", "assetId": "ec81f880-12a4-421b-8594-266fda2fc65e", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"97544b4084e6034b6c7f1812ed0dc902bde9b159681dc4ce9059ce5fc9a3eaa7",
				assetDisposition: "missing",
			},
		],
	},
	{
		appId: "AqirdIW4292Lhd8SF5Wb",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"d761739014fdd729b65e40ad1b8c1c96d1da6e617afc47aebb74666efad833b7",
		threadId: "9ae72add-b4df-4b73-8172-50f3204ee50d",
		sourceMessagesDigest:
			"d4d276365a9fc325f60febba96e0c6926e2cc0733012e7501680dfd08da88a14",
		sourceRowDigest:
			"1229c639424a8966a2035447a8b5337e02bdce1cc68bd89a0df321e8d6a6fa6c",
		resultMessagesDigest:
			"de38db5d1ff3cc372f760f975cb595e95b82a60dcd1f723f3dadbf7fc6f5c953",
		resultRowDigest:
			"7680f097a5e875327ea92f2cdbb103d419b0d34a0ea115ba761d33780841a095",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "0ca3abb6-d038-4cf5-88f9-4e46f2e436cb",
				attachmentText: `{"kind": "text", "assetId": "0ca3abb6-d038-4cf5-88f9-4e46f2e436cb", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"44b9622f9f66ecb334951224f4c1615677b701e4d49b834f99fe454e3de62ab7",
				assetDisposition: "missing",
			},
		],
	},
	{
		appId: "HA4E0qnWYuRJiDAaZgP6",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"bbe744fde63c2fc15ee3752bd9e47bf574adce23f58e4dad89305b4eb98d6b66",
		threadId: "b119bc32-b528-4235-a044-2e610bb17099",
		sourceMessagesDigest:
			"b9d6c54f68c751bb49211310f490416fef872800b719e07a73695de12fbd0825",
		sourceRowDigest:
			"5df9b3559ec080a54a1af8c80f27463338ecca7581e7c009b3fcf9a184dfb82d",
		resultMessagesDigest:
			"ca335653eefe204851c5203be72ed07854099d8fd4df70c96463ffcc1a706e2d",
		resultRowDigest:
			"e5890e966e492be762b0bc1aac234bac4159bcc8d0c5754881b9aefab4b89aae",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "81c6ef03-fdf3-4448-bfcb-155b9f71bb12",
				attachmentText: `{"kind": "xlsx", "assetId": "81c6ef03-fdf3-4448-bfcb-155b9f71bb12", "filename": "03_current_tracker_mama_na_mtoto.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}`,
				attachmentDigest:
					"77587cb24e31c3db5c31c9b368686fe2742ddc7bd07374097dab4177664283d6",
				assetDisposition: "missing",
			},
			{
				messageIndex: 0,
				attachmentIndex: 1,
				assetId: "e9c32489-47e8-4587-bcaf-92df8cb00b81",
				attachmentText: `{"kind": "docx", "assetId": "e9c32489-47e8-4587-bcaf-92df8cb00b81", "filename": "02_SOW_mama_na_mtoto.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}`,
				attachmentDigest:
					"748e3867fdcca87105979b5ca6e5cd805b3b9a17efbd24880e21cbb6eb3d6e38",
				assetDisposition: "missing",
			},
			{
				messageIndex: 0,
				attachmentIndex: 2,
				assetId: "3e536425-70c3-440b-a8fb-e9caf7313204",
				attachmentText: `{"kind": "text", "assetId": "3e536425-70c3-440b-a8fb-e9caf7313204", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"30d4170ba1ba6dea9d279437d1012db5222bdfd57677ff8e855cc7fcfb4f21e5",
				assetDisposition: "missing",
			},
		],
	},
	{
		appId: "HDPlKTPFQkyLVTIjRAeU",
		appProjectId: "LNtlz5zZPLdodMBpEzZk1frlgJGJYeB6",
		appRowDigest:
			"e33bc5b1029003969fe92cba7f93ac42ffe7d7e895021e11a4ca1b51e8322543",
		threadId: "5b28808a-a2bb-4a2b-a3aa-d013741f9f90",
		sourceMessagesDigest:
			"471e7e458d0d4e2f4354efeee84a390a3c8bcbf281530e263b68aa431c2dd9f6",
		sourceRowDigest:
			"21de26758e74f6a54f8e802fcb9cb1782c44a016a065d4dc55615c9cbb5947b4",
		resultMessagesDigest:
			"d8adc8521fd3e5da279b1d61d62a3bc5f83b69b87e0d0294d6edebccf3daffbc",
		resultRowDigest:
			"f05e0d679aa61b30bef7d40eebe7ae5b212a5740d15eda6570246079580e36d2",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "748f9258-219e-4704-b077-98b15fd1c4f5",
				attachmentText: `{"kind": "xlsx", "title": "Indiana Department of Health MCH System Requirements Extract", "assetId": "748f9258-219e-4704-b077-98b15fd1c4f5", "summary": "This document contains functional and technical specifications for the Maternal and Child Health (MCH) system for the Indiana State Department of Health (IDOH). It delineates requirements for client management, provider tracking, birth defect case management, secure communications, third-party interoperability, and extensive cloud-hosting security compliance.", "filename": "Att_O_-_IDOH_Functional_Technical_Requirements.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}`,
				attachmentDigest:
					"fc5ad1b617a9fcd2c7e634039ca34fa11c41ce52ff7a36e67240cbff20481054",
				assetDisposition: "foreign-project",
				assetProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
				assetRowDigest:
					"abfc2fd2166a43d44c3719cdb7006a888f7600ad9ed07979b9f498e7d89f1435",
			},
			{
				messageIndex: 0,
				attachmentIndex: 1,
				assetId: "04c39627-13e8-40ca-beb6-0cfbab732f2c",
				attachmentText: `{"kind": "docx", "title": "Maternal and Child Health Data System — Scope of Work", "assetId": "04c39627-13e8-40ca-beb6-0cfbab732f2c", "summary": "This document outlines the scope of work for the design, development, implementation, and maintenance of a cloud-based Maternal and Child Health Data System for the Indiana Department of Health. It details the transition from four legacy applications, the data migration plan, required system integrations, and non-functional requirements including compliance and security standards.", "filename": "(Source of Truth) 24-75386 - Exhibit A - Scope of Work - Not Tracked.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}`,
				attachmentDigest:
					"4ddc6b5e826249cfde731bbf78522991947078047feade3aca220f3a2e394ad0",
				assetDisposition: "foreign-project",
				assetProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
				assetRowDigest:
					"5567985c921cb53a29a66e419810afaf3adee55f4c4dda2ddf13ade1ea1e44d6",
			},
		],
	},
	{
		appId: "WVbl8blwAsy6CCjBFaJ0",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"c24e40d3209ba02a2c9a38574a0a28d3a9f0302658662662f85364dd8ed708a8",
		threadId: "ca482126-5c41-44ae-8cb2-9f3509ce0c1c",
		sourceMessagesDigest:
			"bcdfa6727591f2ddcf87e354ce832fceec1ec88405e3b1cdf5c6a6365f0cf999",
		sourceRowDigest:
			"aee8b4281a31af755c604134e8793c83b8b481385e4371e4f566cb55dd40c381",
		resultMessagesDigest:
			"360527284e6612aecf12f286ea9318847b2844e7596e8fdbb5031e0640586fd9",
		resultRowDigest:
			"9d9d1d1b92e2d71f1492d34de6ad94371dc4337625d979a5ffa9b308106eebf5",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "266bf631-cb70-40ec-bfdf-3a6e91ebc6b2",
				attachmentText: `{"kind": "text", "title": "Maternal and Newborn Mobile App Requirements", "assetId": "266bf631-cb70-40ec-bfdf-3a6e91ebc6b2", "summary": "This document outlines the operational and functional requirements for a mobile application designed to replace the paper \\"Mama na Mtoto\\" register used by Community Health Volunteers (CHVs) in Migori, Kenya. It covers client registration, antenatal care tracking, delivery records, newborn follow-up visits, and key donor-mandated M&E indicators.", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"1c286596568fae7cfe5f96d8e6985812966a1b30d157c661cac925b2229e82e7",
				assetDisposition: "missing",
			},
			{
				messageIndex: 0,
				attachmentIndex: 1,
				assetId: "fdd3c156-5167-458b-be6b-230582cc6655",
				attachmentText: `{"kind": "docx", "title": "Mama na Mtoto Community Maternal and Newborn Health Digital Application SOW", "assetId": "fdd3c156-5167-458b-be6b-230582cc6655", "summary": "Establishes the terms for designing and deploying a mobile, offline-capable maternal and newborn care application to replace paper registers used by Community Health Volunteers in Kenya. Defines a longitudinal case structure tracking beneficiaries from registration through postnatal follow-up, automated danger-sign referrals, and donor indicators. Details functional requirements, data dictionary fields, implementation schedules, and platform standards in compliance with the Kenya Data Protection Act.", "filename": "02_SOW_mama_na_mtoto.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}`,
				attachmentDigest:
					"6610d25e7d566b99873538a83d3e188a0f6b8fad0a3aa2d4b503cb0efd7b1bc7",
				assetDisposition: "missing",
			},
			{
				messageIndex: 0,
				attachmentIndex: 2,
				assetId: "025d867e-f94d-423d-98ec-e7e4f42d15cc",
				attachmentText: `{"kind": "xlsx", "title": "Mama na Mtoto CHV Register", "assetId": "025d867e-f94d-423d-98ec-e7e4f42d15cc", "summary": "This document specifies the requirements, drop-down taxonomies, calculation rules, and reporting indicators for the Mama na Mtoto CHV Register (v3.2) used in Bonyamatuta Ward.", "filename": "03_current_tracker_mama_na_mtoto.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}`,
				attachmentDigest:
					"ff21c495ef58fba74c35ea8a61f04346b412ffecad4b73fc7c0278aa86d01aa6",
				assetDisposition: "missing",
			},
		],
	},
	{
		appId: "oN4eLy7xPF9QW9bY5iBA",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"a2837798b398b3fe72793b1a822ae6b03a4d0aee821ddd134f0cf849faa20b22",
		threadId: "741dfbbc-e370-4538-8e9d-94ce58ef9f49",
		sourceMessagesDigest:
			"4d970ecae0743c0637a44c301f7cb0013c650565d306bceb5fe6d77e58282d70",
		sourceRowDigest:
			"4cd5a02a18e82c69da8398bc44b65ef6f23d227cc1e0a6f991fd5e3c94722811",
		resultMessagesDigest:
			"2e1e82dc67a28990c8f1b7e949dace3f9750709c789083fa8516e4519c0029a9",
		resultRowDigest:
			"11ebd961d201f176099e331833709d2c8416d4110540828867811588d06d0935",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "1fb10514-fb3c-4745-bd06-67bb4db375b3",
				attachmentText: `{"kind": "image", "assetId": "1fb10514-fb3c-4745-bd06-67bb4db375b3", "filename": "06_workshop_whiteboard_growth_monitoring.png", "mimeType": "image/png"}`,
				attachmentDigest:
					"f6b5427d72f05e54eae37d899051d36a7e6f97dbe7e6e843e9ca9a7be66216bb",
				assetDisposition: "missing",
			},
			{
				messageIndex: 0,
				attachmentIndex: 1,
				assetId: "3d41053b-9442-4171-a724-01f5a0c260b4",
				attachmentText: `{"kind": "text", "assetId": "3d41053b-9442-4171-a724-01f5a0c260b4", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"db4a191022e75b2958116e86f6d2ef899c51548a12b2c39aa7e32d83a6cf50cc",
				assetDisposition: "missing",
			},
		],
	},
	{
		appId: "y8Kk0N28YvGVqA0cQUIM",
		appProjectId: "65b287a5-fece-46a6-9948-6a26519836b7",
		appRowDigest:
			"834106aaf2f21d2127717b1fc30af1c08b75d484e2b36028ef6a8d54556417fc",
		threadId: "d416f0fd-9097-408b-874b-6a8f1f70691b",
		sourceMessagesDigest:
			"56bf911569aa71fab19ec1099cdc22a28e446bcf83a2b562404c6362cd142fe3",
		sourceRowDigest:
			"6839346be0e401c0a8d06b120f72a957af04e2e95585fffb4f1f51ae549aae5b",
		resultMessagesDigest:
			"8b502a3a26ebe2976e95c0b0538b536d4067b78d15936b93601480c75e0f9771",
		resultRowDigest:
			"fae6cf60de514e293674258216b7678b29888a4e30805d99bf41c445457126fc",
		targets: [
			{
				messageIndex: 0,
				attachmentIndex: 0,
				assetId: "158ff67f-7572-4eb3-9836-a0450db72ac9",
				attachmentText: `{"kind": "text", "title": "Maternal and Newborn Mobile Application Requirements", "assetId": "158ff67f-7572-4eb3-9836-a0450db72ac9", "summary": "This document outlines the operational and functional requirements for digitizing the 'Mama na Mtoto' paper register into a mobile application for Community Health Volunteers (CHVs) in Migori. It details client registration, pregnancy monitoring, postnatal follow-up, and supervisor viewing workflows, with a strong focus on offline functionality for cheap Android devices and alignment with donor-mandated indicators.", "filename": "01_email_thread_maternal_newborn_app.md", "mimeType": "text/markdown"}`,
				attachmentDigest:
					"db8293b25b5223a6f75c4ed42435fac0d91721f6ac33a089c4e3da3c1c68bab4",
				assetDisposition: "missing",
			},
		],
	},
] as const satisfies readonly FrozenThreadAttachmentRepair[];

export const FROZEN_THREAD_ATTACHMENT_REPAIR_MANIFEST_DIGEST =
	"19c9dbcb3f979423b880efc34b1c1497397ed3da7df9727ff2f473dff312cf09";
export const FROZEN_THREAD_ATTACHMENT_REPAIR_EVIDENCE_DIGEST =
	"19f9fd14266ad70d55304ac9864f130ccae08a2a166b98c4542795d826c3fc13";

/**
 * Exact schema/row closure for the sole app whose Project was absent in the
 * frozen production snapshot. The repair hashes the id and complete JSONB row;
 * plaintext authored/app content is intentionally absent from source control.
 */
export const FROZEN_PROJECT_ORPHAN_APP_ID_DIGEST =
	"920fcf6c39dbcb4a76af021b8a2a741cfdd65944cf9a0d947667ac7cad0b155d";
export const FROZEN_PROJECT_ORPHAN_LEGACY_SNAPSHOT_DIGEST =
	"e411f7e0234f9d8fb2502066ee8a6cd977ed280c826937f07cb79ec2d3b473ce";
export const FROZEN_PROJECT_ORPHAN_APP_ROW_DIGEST =
	"d22416c8b4509c21aaadff3553febfc97a23e4a1b8d4b204d75e399f7bfd5421";
export const FROZEN_PROJECT_ORPHAN_APP_ROWS_DIGEST =
	"a7eb7d5e887df5d8a1433a30f9001e1ca8d00bbbe41caae5d20fca0468198d7d";

/**
 * Relations this cutover renames, pre-cutover name to post-cutover name.
 *
 * The forensic repair runs before the migration, so every inventory it owns
 * names `accepted_mutations`; the migration then does
 * `ALTER TABLE accepted_mutations RENAME TO app_changes`, and every
 * post-cutover consumer — the audit identity's grants, the fold, the browser
 * stream — sees only the new name. It is one relation under two names on
 * either side of the horizon, so anything comparing a pre-cutover inventory
 * against a post-cutover set projects through this map rather than carrying a
 * bare exception for the difference.
 */
export const FROZEN_HORIZON_TABLE_RENAMES: Readonly<Record<string, string>> = {
	accepted_mutations: "app_changes",
};

export const FROZEN_PROJECT_ORPHAN_APP_ID_TABLES = [
	"nova_case_runtime.cases",
	"public.accepted_mutations",
	"public.blueprint_entities",
	"public.case_type_schemas",
	"public.chat_stream_chunks",
	"public.events",
	"public.form_attachments",
	"public.form_submission_intents",
	"public.lookup_column_references",
	"public.lookup_table_references",
	"public.media_asset_refs",
	"public.parked_case_values",
	"public.presence",
	"public.run_summaries",
	"public.threads",
] as const;

export const FROZEN_PROJECT_ORPHAN_TABLE_CLOSURES = [
	[
		"nova_case_runtime.cases",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.accepted_mutations",
		1,
		"dd086d581a0f8f206d4bf682c4a39c0126fab4b1135d2e7248512c5c33b8bd07",
	],
	[
		"public.blueprint_entities",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.case_type_schemas",
		1,
		"0f6f27dc7be5b94cc2d6be05aee17feb62fa85418e0d64cfe0ae6a227f162c9c",
	],
	[
		"public.chat_stream_chunks",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.events",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.form_attachments",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.form_submission_intents",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.lookup_column_references",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.lookup_table_references",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.media_asset_refs",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.parked_case_values",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.presence",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.run_summaries",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
	[
		"public.threads",
		0,
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	],
] as const;

export const FROZEN_PROJECT_ORPHAN_AUTH_TABLES = [
	"auth_account",
	"auth_apikey",
	"auth_invitation",
	"auth_member",
	"auth_organization",
	"auth_session",
	"auth_user",
] as const;

export const FROZEN_PROJECT_ORPHAN_AUTH_CLOSURES =
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES.map(
		(table) =>
			[
				table,
				0,
				"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
			] as const,
	);

export const FROZEN_PROJECT_ORPHAN_DEPENDENCY_INVENTORY_DIGEST =
	"cdee8dfff3e986d5ed566b00b152f2bab49a49e81e53d149ceb8f09ff2292545";
export const FROZEN_PROJECT_ORPHAN_FULL_DISPOSITION_DIGEST =
	"4a20a49daee11d2aacf56459694bdc7cc8bbcdc8c920a779eb9f642f4207ca4f";

/** [app-id digest, row UUID, full persisted-row digest] */
export const CANONICAL_IDENTITY_ROW_DELETES = [
	[
		"0bdb38f290c35dac3f2fc4841ae3b34cee798ccc6ef581a76922cb9c1a3612aa",
		"1c4096b5-3699-4bd9-b9b2-e2b2c999072c",
		"55d12104f73ce8eeed2e25f115118f49f5012a4786440a7e25729741d62ae63f",
	],
	[
		"0bdb38f290c35dac3f2fc4841ae3b34cee798ccc6ef581a76922cb9c1a3612aa",
		"3f42c758-2361-449f-b0e1-18587bcddead",
		"fa7dd4d214c55922cff2c83cdc051cf8692e9c544f50040e0cbd45191a161aa7",
	],
	[
		"0bdb38f290c35dac3f2fc4841ae3b34cee798ccc6ef581a76922cb9c1a3612aa",
		"daeddfbe-ec50-4252-af28-3f1d189ece2d",
		"cba9d3e3809a8be27059e1200477e0b945e11de097ff78f00bf17438d3590868",
	],
	[
		"0bdb38f290c35dac3f2fc4841ae3b34cee798ccc6ef581a76922cb9c1a3612aa",
		"f74dc28d-d91c-4d61-8481-cfc740f181f2",
		"a3bedafe5fca1c101fc507f67543937861eaf672c4e72e4456a38c209d0b8932",
	],
	[
		"2dc9a5e094b768337883bdaafe346cfa7666ee1d342294833dcb6b642daea384",
		"97e2adc8-5504-4db2-91ee-8b8a3b0a420b",
		"2dddbc5ea3254e0901d4fc16fd4a36ab68b0ca09efcc4719bb1c983216054109",
	],
	[
		"3dc48a322b0a34d624dde1deb6ac4dc4e1d3e902f74f69f3c6d4fc78da04e855",
		"1afbedde-fc66-4e91-aade-bcd03a5964b8",
		"646f29b07a0226d886a3fbb7ee673ad031372280d3268c3ff2a9b0b532db9fc9",
	],
	[
		"3dc48a322b0a34d624dde1deb6ac4dc4e1d3e902f74f69f3c6d4fc78da04e855",
		"5eab99fb-31f8-44ca-a59f-248e7012a684",
		"216b317e98d4c53f493a4f9c47082d8602a8255efbb76298085114a9209db359",
	],
	[
		"425dd3d87c3e6211e7b5266fb040a4d1e82e8754932691d924d4ab06f1d3040b",
		"593b7230-df9e-4d57-b806-2307e1459ea1",
		"f038635f422cd614b913f3e5bb0e33483f567872cc35347aea11f0920386a475",
	],
	[
		"674fc8f24b4a4646daa674aadac91581c5b22fe870b4e8c6723e31a193b17cfd",
		"2780dced-00ca-421f-af3e-4fc7457efcf2",
		"ca814fd2797ec5d634b2dbc5a938e7c5b4c0dfba33d703b4b37446d61f7d6a3a",
	],
	[
		"674fc8f24b4a4646daa674aadac91581c5b22fe870b4e8c6723e31a193b17cfd",
		"283422a5-a1a5-4e25-9d2a-3c2de180c1d0",
		"031d5b91eb98ce3dc6276bb839b8b3b8ba1f7ba4855acee57d4f2f5364728bc4",
	],
	[
		"674fc8f24b4a4646daa674aadac91581c5b22fe870b4e8c6723e31a193b17cfd",
		"94b61958-fc04-43bd-ba28-5e0ee6c85438",
		"0e76356ed7b7fc7657a1049aae2ed904183e1f118c23a5b567db49498dd35e1c",
	],
	[
		"674fc8f24b4a4646daa674aadac91581c5b22fe870b4e8c6723e31a193b17cfd",
		"973271f1-55fb-4b82-9b28-d455d0afe39d",
		"dcf4efe79a2df6f7abec5891c9a699a1dae0cb1a3fa37d71e718c401ca07cd62",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"1029c500-c53b-49d5-b2d2-ac53486ffb5e",
		"f79833e6c7b6d20acfb58e329421a2d1e7db73f890a727dbb97cc2c90c665132",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"14f2aace-b1e6-4afb-b4cd-6ce317d57798",
		"a8ca8b1cee5b8ac52211142cd45b83a7d5cd47041c895ab9a2246b6ffab49e9a",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"261a4228-7bf6-400e-b4da-9bcc7fc51e3b",
		"a4ea502902b9d4e838782842b9db83cce16e32fb4ba77b1d3a557111004d3e3b",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"3370a999-2524-4dd4-a8ff-6bc9b17d4678",
		"39ece57c1589552ab7827051597fde39619559a3c8694eb2bb9780891ebc09d1",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"37f46b39-a6b6-4e2e-a6b8-3d3235b0dbbb",
		"4b13a0f02ef40e193b85b4ee86a81424dbd2327e8b8fd07a53499432854f3e94",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"609018c1-7e7e-4d23-9312-77daf1973bfb",
		"30aab862cfbba27fd87d094fa19276700641a7c3d3b059c01a6faec906e0e783",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"74f9e7c2-f3f5-4b06-a4cb-c0fa76d4cdfa",
		"81aabca153f85237d84e92a1f531e7dc07d5f0f6d9e0d7aa633270fd0c52fa5b",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"8aa16f5a-c00c-41df-a44d-8fdc7463eb03",
		"cdebaed742274523f335d54af9218e5f451340fb72879ab2e1f92e384f828bc3",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"8ae64602-2dfb-4d7d-b148-d88d578c0ed9",
		"32c1e0280b51d11635e0444212119793486d7fccbb3cba204f11bf7ff4c80be4",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"953d9c22-7f07-4eac-a933-c9b0175e016c",
		"b86f71a6789356b6234100eb1b7ca4997ff68bc1920cd61e06fd9551dc81e869",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"9c844e77-3e3c-4a9e-b0ca-f5e22643ab74",
		"6182aba7299ff03c6bc7a7ded7e85061d2c7ad0f35c0f03e875b6edb5c4e1f67",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"afe724f9-d50b-4ce7-9bab-04bab2f7c963",
		"a341a5ad5b8b6b6bc4956f7fb799581e81d884b7a3c99950c74da6947a8b816e",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"cbc146fb-d1cc-400f-bf61-e2b0a9dd809c",
		"6eec7eae014029e3e27ce3ffaaceba6236b1f6af9affd3a80e1ab7b5bd925690",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"cc0e7cb0-1fce-4a39-8e76-038d597726e0",
		"e3770b44187243ace3f75265eb9ed0c7d7f9347239d60826a25926cc83e0cb41",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"ccb962d7-5a12-4b07-bc61-c9afeb2fa63a",
		"c08ce2c21fe66de21e4e144b3bf94005045ceb91197ef6f2d87935a32813e32f",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"d5552101-8295-4784-a201-26ee282c62af",
		"0d281734d2cf88090db754701c1eb32006f35956a8c1fa6c0e6ecb1b7bad81c1",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"db593769-8f91-4850-adba-d23f9126212b",
		"8f84bbc04c9e54e64ae335655bc7c307443421015b29c07e5bcb33e0f44f4766",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"e7587d2e-cad0-4c6b-b99f-a878c8b0d434",
		"75607064ae246a388165fba86c7dac1f4fff9f873f8becf0f5bb3340f8630962",
	],
	[
		"a068aaa2fb64604c30d1509769d393050f5f436392bcac099ba1a5240258877f",
		"2e0547a1-009d-4941-82c7-659d0581c972",
		"14cbcca4b7daf15d6f93f4237a958973c311a3956d6e972659eaa027c04c4e09",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"29ec4b9a-3415-4ada-9d05-16941d9adc2c",
		"82083d5db591dec2138ff191a06857fee4f7c3a0780fc00fc8180ab80e064338",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"387e11bf-a2fe-44cf-b6fa-bdf5b52e6673",
		"e4ef06f0bdbdb6dee45181fcd554e2d82f17c45e418b1c9d4e08c067eb888df6",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"57dd5e9a-23e9-4979-bab8-8d2c11fa2bc0",
		"6d30e15d7f7ee2163f48d60e6f7b7e23fd0d93a423af55d1f092fc7dbcb207f5",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"9514b294-273c-4ca4-b5cc-66a98ea67958",
		"bd0ca1e4745cb1f702b475df9963bf91a551e5b9546bb5fbb3f86cc4bc494801",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"99149892-7741-42a7-801f-f672799a3cb3",
		"b930b4e829f5d0efa24dff637a5fdcc94f2ecbe2b89298bc2eb1164107366dcb",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"da387715-0ec9-40ce-8259-803d957d8c36",
		"310d43e2d65524fa84cab0b0702986aa28e09aa7eaec74ab9cf0dd229b506b09",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"f4391eab-4dea-4622-bd57-35f4ab8d32d1",
		"70b4da6efff100ba4f11cc38274b2de57a173fc0e16d86433f9694fe1214d7f5",
	],
	[
		"c10577dad7f54e468a64017aed81ef70ca867d231344c93b981bd9d9f49d519d",
		"9db5574d-557b-40e0-ab6e-43cc0e4818eb",
		"68004f98e57e09a93319d3ff5a3973ea7cee1a0d996f8b924815267369f9ac7b",
	],
	[
		"d31c08e6af005abf53a634eb8d34e89211aadc9f7be653ccd2a7a7ff976ef536",
		"021899eb-1e8c-4732-ba27-c911a36a86c1",
		"1add53071e6808a960cfab16897509951ad764021cdd47a8b28de3895f176d74",
	],
	[
		"d31c08e6af005abf53a634eb8d34e89211aadc9f7be653ccd2a7a7ff976ef536",
		"d70c0578-ea57-420b-89a4-962587bf1dd1",
		"e2e746802d8edd9656b485e5f7235b8ee0dc3523ab3a304f2f1eedbe4863e05e",
	],
	[
		"ed2cd3f636d0ded6dcbd9bc7c2e9ff48059da070271ba15e69655a2512518a86",
		"2676ae5f-0aab-4b44-95d9-223886137d64",
		"a5b0a7f8d974f716ebf078109fd3bd77379af26433a39c05087d2a26b755cdb8",
	],
] as const;

export const CANONICAL_IDENTITY_PROPERTY_PROJECTIONS = [
	{
		appDigest:
			"2dc9a5e094b768337883bdaafe346cfa7666ee1d342294833dcb6b642daea384",
		sourceRowUuids: ["97e2adc8-5504-4db2-91ee-8b8a3b0a420b"],
		sourceRowsDigest:
			"f94680f954b1be05e7729c631b47fe6507438358079780331fb96fecee16ccab",
		projectionDigest:
			"e365ead57ab2287f5181d6f9c87ded78aa276d8de9c2b8234fae3a0b03927f7e",
	},
	{
		appDigest:
			"a068aaa2fb64604c30d1509769d393050f5f436392bcac099ba1a5240258877f",
		sourceRowUuids: ["2e0547a1-009d-4941-82c7-659d0581c972"],
		sourceRowsDigest:
			"abe1f6d83dcb6438e3e45eeeb7a24159da931427649983c7279c36aac94e0fab",
		projectionDigest:
			"ab6582d7ea4fe3d2ffe9e4ba9dc12af8c4f162dc995389c65b27d9da404f757f",
	},
] as const;

export const CANONICAL_IDENTITY_LABEL_REPAIR = {
	appDigest: "bc1a22535790949c653ed00776ccb34ae32db796dd14de068194dd1965893b6d",
	fieldUuid: "e00ec2d2-466e-4d3c-b2e7-cd34a71a71e1",
	fieldUuidDigest:
		"614a28ebdd2efc87d2246dd467782875db8aff1506a2a1a533177cfe035cff76",
	sourceDigest:
		"c0ab5183a087addd70ff4d9418c12d28c7db3fcf8161328304c2d5b7e255ab0d",
	sourceBytes: 252,
	/**
	 * Exact zero-based UTF-8 byte spans from the approved production row.
	 * These are the complete replacement AST recipe: text is copied only from
	 * the gaps between pinned spans, five spans become the named field atom,
	 * and one becomes no part. Runtime regex/path resolution is forbidden.
	 */
	replacementParts: [
		{
			startByte: 12,
			endByte: 45,
			sourceDigest:
				"db018b51b2bdf63fbe9427ec4fd235c8a568ce911f01549222a4d8850cbfa297",
			replacement: {
				kind: "field-ref",
				uuid: "d0ee8c4c-d357-4586-99c8-dd38f8e11a84",
			},
		},
		{
			startByte: 63,
			endByte: 96,
			sourceDigest:
				"61f0fac2bb6cff7a90ba9d8f5058324b4e9cbedffa84f2123aeb83f98d3afbdb",
			replacement: {
				kind: "field-ref",
				uuid: "46fc2817-e81d-4670-a7c3-a051160060c1",
			},
		},
		{
			startByte: 112,
			endByte: 122,
			sourceDigest:
				"223a43028e7a3b19c3b91a32c9623ecd9fdc25c5a65ee1e157efa3de623cbb65",
			replacement: null,
		},
		{
			startByte: 145,
			endByte: 162,
			sourceDigest:
				"c47af2e350ff8ac0c419b24098866bce1cf5504ac9ed240b37b3c303a7e99c48",
			replacement: {
				kind: "field-ref",
				uuid: "b1e6791c-f38d-4425-8682-91e75af560b5",
			},
		},
		{
			startByte: 189,
			endByte: 213,
			sourceDigest:
				"f9b70c76662b166d9d28f6cd9f50cf2a36888fc93a2fcd35f1ca669560f42a53",
			replacement: {
				kind: "field-ref",
				uuid: "7824589e-81f5-4a1c-898a-8afa016b9435",
			},
		},
		{
			startByte: 234,
			endByte: 252,
			sourceDigest:
				"f4e6d453282d1bd701ae3990852141410f765e34a47a243b0b6a8a2fc83d1fb6",
			replacement: {
				kind: "field-ref",
				uuid: "9b32a512-424a-4bfe-ade9-052f07b4d93d",
			},
		},
	],
	replacementDigest:
		"62b3f2603e702b820eeee4adfc7d1816144e6a24c97e752a484a0a1386a6369b",
} as const;

export const CANONICAL_IDENTITY_CATALOG_CLEARS = [
	{
		appDigest:
			"3435e59fa920ef8f46fee29c69d26c8083c574359fb3bca24a8f258cfd78862f",
		caseTypeIndex: 0,
		propertyIndex: 9,
		slot: "validation",
		sourceDigest:
			"59c896e011bbcf6a75009ca3f995d595943fb17b98fad962995f37e828451ac1",
		sourceBytes: 36,
	},
	{
		appDigest:
			"3435e59fa920ef8f46fee29c69d26c8083c574359fb3bca24a8f258cfd78862f",
		caseTypeIndex: 0,
		propertyIndex: 10,
		slot: "validation",
		sourceDigest:
			"59c896e011bbcf6a75009ca3f995d595943fb17b98fad962995f37e828451ac1",
		sourceBytes: 36,
	},
] as const;

/** [app-id digest, exact complete pre-repair digest, repaired digest] */
export const CANONICAL_IDENTITY_AFFECTED_APPS = [
	[
		"0bdb38f290c35dac3f2fc4841ae3b34cee798ccc6ef581a76922cb9c1a3612aa",
		"b5eee6feea233d62404c3ac26447aa533f6b06089fbda2c12fd40c49fab09e03",
		"4a6be1387ea45917c9d845ef69152a0b48d8a97d2354adaec38463b2ec32e9b4",
	],
	[
		"2dc9a5e094b768337883bdaafe346cfa7666ee1d342294833dcb6b642daea384",
		"5ff169d744e6a29e515caa095f4396f83946d69f97f2ff45ec2ba1a7e2729301",
		"8f36929442c688cbe641cc1dbdc83476c77cad96da5e5666c977ee97d1a1b373",
	],
	[
		"3435e59fa920ef8f46fee29c69d26c8083c574359fb3bca24a8f258cfd78862f",
		"0613a61f6b031f080d8a33a8f43fda5859c2d307f28077d72a0c77f3f712f0cb",
		"778185128bae7d92983225681b56d9328f123f541aec374225cada675b6f16de",
	],
	[
		"3dc48a322b0a34d624dde1deb6ac4dc4e1d3e902f74f69f3c6d4fc78da04e855",
		"0151553472a4cd351ae29a751f26b409c0e7ac0522ef6c0b106a0531a68860ce",
		"0cbb034154f72bb6f896228b3c06baecb1c5af8123e9bad9da39b6a6c92d34e7",
	],
	[
		"425dd3d87c3e6211e7b5266fb040a4d1e82e8754932691d924d4ab06f1d3040b",
		"5f541957d8739ac00fbbcb1722137a68240592998a7033078011956cf49f050b",
		"bcee7f3f3441645bbf5ec4df129167500034779a197583ab23bb19aeb721104c",
	],
	[
		"674fc8f24b4a4646daa674aadac91581c5b22fe870b4e8c6723e31a193b17cfd",
		"70d96d4f627269daa53e833c4fde99a903397a3e94510e5e74ebdace4ae5e412",
		"ce3fba98af06a4ba16c41ecd46d8be3f05299666b0c96e981b9378dbaabd010b",
	],
	[
		"8af3e6a27436c0a383f386c0b77b6b1099ead51e0b85ffde6eaa165f1379b6ce",
		"d1ffe2acc7b6c45f55cb8e59a0b1bc45a0278195fbd65c37dd8adbf9c5a5301b",
		"37611fa1581fcbb207287e621a62c2f6f52b2a13dd474257bbe5fe74949f338d",
	],
	[
		"a068aaa2fb64604c30d1509769d393050f5f436392bcac099ba1a5240258877f",
		"19b72eedea315bdea1fe4794b2c3ab48840279dacb409bfeb02458964d970e62",
		"2ec7928d42efc30c3d96d1ece2ae0088dd665c26c9ff4ae910c16e57fb2c7e95",
	],
	[
		"ba370b13989d9762fd93fe3cc78cdf29166bcc38738429116f2492e22fe24cfa",
		"672ff431086c121d173df0172d6c7a0151caacb12780e8a89fe87a6f3681b4ef",
		"d954e41fd3c2cefb3fd746fea728ea25a1efa58cdfa33b51139a693dc2ad10bc",
	],
	[
		"bc1a22535790949c653ed00776ccb34ae32db796dd14de068194dd1965893b6d",
		"c4e8cda143823c3d000c55cc59559d232fdc8f280ff177b1ad96e4a95e3568f4",
		"445c796b0735f3e82bcf91e6c6737f458e169fdcdb14a41258778b99c49665f9",
	],
	[
		"c10577dad7f54e468a64017aed81ef70ca867d231344c93b981bd9d9f49d519d",
		"9c38d462d88d0b5b006aad1ee52b11b82a4d5c6e697c78558e1766a275919dae",
		"9955a5d048a64788fb6ee6b228055582d6830e7e36298dd9ed3a088b756ee730",
	],
	[
		"d31c08e6af005abf53a634eb8d34e89211aadc9f7be653ccd2a7a7ff976ef536",
		"1b631675b4562e004044b1efcd26cf96b80f93fe0af01fc834803ac813c90fc0",
		"25fd4200caaeb26ce7d4930d990b49c6b97cf1b75d6a21df0ee8efe41b5c2a53",
	],
	[
		"ed2cd3f636d0ded6dcbd9bc7c2e9ff48059da070271ba15e69655a2512518a86",
		"6576fe146c7a0693b444c06ee7dea998767989463b2d22fb73d4c335ea2ef634",
		"190a58533c2b8403a2827c47bbe5c871d584c267ba1ae38b978072259888b8e0",
	],
] as const;

export const CANONICAL_IDENTITY_REPAIR_RESULT_DIGEST =
	"df85929374a012b779793251f980b241592218b2c99a90610312b17af5b9f649";
