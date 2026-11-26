"""Which submitted Connect nodes HQ's application-resource summary exposes."""


def test_an_activity_in_a_group_is_summarized_by_its_submitted_leaves(hq):
    from corehq.apps.app_manager.xform import XForm

    source = """<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:vellum="http://commcarehq.org/xforms/vellum">
      <h:head><h:title>Visit</h:title><model>
        <instance><data xmlns="urn:visits"><person/><visit>
          <service vellum:role="ConnectDeliverUnit"><deliver xmlns="http://commcareconnect.com/data/v1/learn" id="service">
            <name>Visit</name><entity_id/><entity_name/><work_area_id/>
          </deliver></service>
        </visit></data></instance>
        <bind nodeset="/data/person" type="string"/>
        <bind nodeset="/data/visit/service" relevant="/data/person != ''"/>
        <bind nodeset="/data/visit/service/deliver/entity_id" calculate="/data/person"/>
      </model></h:head>
      <h:body><input ref="/data/person"><label>Person</label></input>
        <group ref="/data/visit"><label>Visit</label></group></h:body></h:html>"""
    questions = XForm(source, domain="visits").get_questions(
        ["en"], include_groups=True, include_triggers=True, include_translations=True
    )
    rows = {q["value"]: (q["type"], q.get("calculate"), q.get("relevant")) for q in questions}
    assert set(rows) == {
        "/data/person", "/data/visit", "/data/visit/service/deliver/name",
        "/data/visit/service/deliver/entity_id", "/data/visit/service/deliver/entity_name",
        "/data/visit/service/deliver/work_area_id",
    }
    assert rows["/data/visit/service/deliver/entity_id"] == ("DataBindOnly", "/data/person", None)
    for leaf in ("name", "entity_name", "work_area_id"):
        assert rows[f"/data/visit/service/deliver/{leaf}"] == ("DataBindOnly", None, None)
