"""Observe an authored assignment from date and time to case owner."""

from proof.hq import operations
from proof.hq.test_case_processing import _case, _person, _submission


def test_hq_uses_the_date_of_a_direct_datetime_assignment_as_the_case_owner(
    hq, core_runner, webapps_documents, evidence,
):
    """Exercise the retained Followup assignment rather than a simulated lookup."""
    from lxml import etree

    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.webapps import hq as webapps_hq

    document = webapps_documents["hq-case-management"]
    change = next(
        row.change for row in registry.load_variants()
        if row.id == "hq-case-management/datetime-saved-straight-as-the-case-owner"
    )
    instant = "2025-04-05T23:24:47.125Z"
    day = "2025-04-05"
    with webapps_hq.authored_project(document, "A") as project:
        authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        ops.set_json(authoring, project.app_id, change["pointer"], change["value"])
        app = operations.held_app(project.unit, project.app_id)
        form = app.modules[0].forms[3]
        xform_source = form.render_xform()
        root = etree.fromstring(xform_source.encode() if isinstance(xform_source, str) else xform_source)
        owner = root.xpath("//*[local-name()='bind'][contains(@nodeset, '/update/owner_id')]/@calculate")
        stored = form.actions.update_case.update["owner_id"].question_path
        opened = operations.process_case_blocks(project.unit, _submission(_person()))
        moved = operations.process_case_blocks(
            project.unit,
            _submission(_case("c-new", f"<update><owner_id>{day}</owner_id></update>")),
            cases=[opened.touched["c-new"].case],
        )
        actual_owner = moved.touched["c-new"].case.owner_id if moved.refusal is None else None
        evidence("datetime-case-owner", {
            "binding": owner, "storedField": stored, "selectedInstant": instant,
            "submittedDay": day, "storedOwner": actual_owner, "refusal": str(moved.refusal),
        })
        assert stored == "/data/seen_at"
        assert owner == ["format-date(/data/seen_at, '%Y-%m-%d')"], owner
        assert actual_owner == day
