/**
 * Exact UTF-8 contents of CommCare HQ's accepted v2 case-update fixture:
 *
 * `commcare-hq/corehq/ex-submodules/casexml/apps/case/tests/data/v2/basic_update.xml`
 *
 * `Version2CaseParsingTest.testParseUpdate` submits these bytes and asserts
 * that `case_name` becomes the existing case's current name. Keep the closing
 * backtick on the same line as `</form>`: the upstream 454-byte fixture has no
 * final newline.
 */
export const CCHQ_BASIC_UPDATE_XML = `<?xml version='1.0' ?>
<form version="1" uiVersion="1" xmlns:jrm="http://openrosa.org/jr/xforms"
	xmlns="http://openrosa.org/case/test/create">
	<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="foo-case-id"
		user_id="bar-user-id" date_modified="2011-12-07T13:42:50">
		<update>
			<case_type>updated_v2_case_type</case_type>
			<case_name>updated case name</case_name>
			<dynamic>something dynamic</dynamic>
		</update>
	</case>
</form>`;
