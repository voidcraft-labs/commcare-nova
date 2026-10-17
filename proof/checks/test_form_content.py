"""A built form's content, as proof 2's version clause reads it: the bytes HQ hashes, the data node's version aside.

Contract: ``compare.versions.form_content`` is a built XForm's bytes with
the value of its data node's own ``version`` attribute set aside, as HQ's
``Application.set_form_versions`` decides whether a form keeps the previous
build's version (an MD5 of the rendered file against that build's file,
the version set to the previous one). The plausible failures: a version
read as content (so every form HQ gave a new version looks changed), a
layout read as no change (so a version HQ moved over another layout of the
same tree is reported), and another attribute or another element's
``version`` set aside with it.
"""

from __future__ import annotations

from proof.checks.compare.versions import form_content

FORM = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms">'
    "<h:head><h:title>Visit</h:title><model><instance>"
    '<data xmlns="http://example.com/f" uiVersion="1" version="{version}" name="Visit">'
    '<q version="{inner}"/></data></instance>'
    '<instance id="casedb" src="jr://instance/casedb"/></model></h:head><h:body/></h:html>'
)


def _form(version="3", inner="1", form=FORM):
    return form.format(version=version, inner=inner).encode("utf-8")


def test_the_same_bytes_under_two_versions_are_one_content():
    assert form_content(_form("3")) == form_content(_form("12"))
    assert form_content(_form("3")) != _form("3")


def test_another_layout_of_one_tree_is_another_content():
    relaid = FORM.replace('<q version="{inner}"/>', '<q version="{inner}"></q>')
    reordered = FORM.replace('version="{version}" name="Visit"', 'name="Visit" version="{version}"')
    indented = FORM.replace("<instance><data", "<instance>\n\t\t\t\t<data")
    for other in (relaid, reordered, indented):
        assert form_content(_form(form=other)) != form_content(_form())


def test_only_the_data_nodes_own_version_is_set_aside():
    # The XML declaration's version, the data node's other attributes and a child's version are content.
    assert form_content(_form(inner="1")) != form_content(_form(inner="2"))
    declared = FORM.replace('<?xml version="1.0"', '<?xml version="1.1"')
    assert form_content(_form(form=declared)) != form_content(_form())
    renamed = FORM.replace('name="Visit"', 'name="Visit again"')
    assert form_content(_form(form=renamed)) != form_content(_form())
    prefixed = FORM.replace('version="{version}" name', 'x:version="{version}" xmlns:x="urn:x" name')
    assert form_content(_form("3", form=prefixed)) != form_content(_form("12", form=prefixed))
    # A version written in single quotes, or before a ``>`` inside another attribute's value, is the one read.
    quoted = FORM.replace('uiVersion="1" version="{version}"', "uiVersion='a>b' version='{version}'")
    assert form_content(_form("3", form=quoted)) == form_content(_form("12", form=quoted))


def test_a_file_with_no_data_node_version_is_its_bytes():
    unversioned = FORM.replace(' version="{version}"', "")
    assert form_content(_form(form=unversioned)) == _form(form=unversioned)
    assert form_content(b"<suite/>") == b"<suite/>"
    assert form_content(FORM.format(version="3", inner="1")) == form_content(_form("3"))
