"""Observe how an advanced index uses the raw answer in HQ's authored form."""

import pytest
from lxml import etree

from proof.hq import operations
from proof.hq.test_case_processing import _case, _create, _person, _submission
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.webapps import hq as webapps_hq


def test_an_advanced_index_forwards_the_unrestricted_relationship_answer(
    hq, core_runner, webapps_documents, evidence,
):
    document = webapps_documents["hq-advanced"]
    change = next(
        row.change for row in registry.load_variants()
        if row.id == "hq-advanced/open-relationship-by-question"
    )
    with webapps_hq.authored_project(document, "A") as project:
        authoring = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
        ops.set_json(authoring, project.app_id, change["pointer"], change["value"])
        form = operations.held_app(project.unit, project.app_id).modules[1].forms[0]
        source = form.render_xform()
        root = etree.fromstring(source.encode() if isinstance(source, str) else source)
        relations = root.xpath("//*[local-name()='bind'][contains(@nodeset, '/parent/@relationship')]/@calculate")
        note, = root.xpath("//*[local-name()='bind'][@nodeset='/data/notes']")
        assert relations == ["/data/notes"] and not note.get("constraint"), (relations, note.attrib)

        parent = operations.process_case_blocks(project.unit, _submission(_person("loaded-parent")))
        assert parent.refusal is None
        parent_case = parent.touched["loaded-parent"].case

        def submit(answer, owner):
            body = _create("member", "Ordered case").replace("<owner_id>u-1</owner_id>", f"<owner_id>{owner}</owner_id>")
            body += f'<index><parent case_type="person" relationship="{answer}">loaded-parent</parent></index>'
            return operations.process_case_blocks(
                project.unit, _submission(_case("child-" + answer, body)), cases=[parent_case],
            )

        observations = {}
        for answer, owner in [("child", "u-1"), ("extension", "-")]:
            result = submit(answer, owner)
            assert result.refusal is None
            case = result.touched["child-" + answer].case
            index, = case.indices
            observations[answer] = {
                "owner": case.owner_id,
                "relationship": index.relationship,
                "target": index.referenced_id,
            }
            assert observations[answer] == {"owner": owner, "relationship": answer, "target": "loaded-parent"}

        with pytest.raises(KeyError, match="other"):
            submit("other", "u-1")
        evidence("advanced-relationship-answer", {
            "relationships": relations, "note": dict(note.attrib),
            "valid": observations, "invalid": "KeyError",
        })
