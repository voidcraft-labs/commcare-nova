"""A form edit past Nova's gate for the clients' submitted-answer controls."""

from lxml import etree


def with_submitted_answer(source, name):
    # Use the otherwise identical working form. Sync dispatches only with its own namespace.
    tree = etree.fromstring(source.encode() if isinstance(source, str) else source)
    (answer,) = tree.xpath("//*[local-name()='instance' and not(@id)]/*/*[local-name()='visit']/*[local-name()='script']")
    if name == "sync":
        etree.SubElement(answer.getparent(), "{http://commcarehq.org/sync}sync").text = "Ordinary answer"
    else:
        answer.tag = f"{{{etree.QName(answer).namespace}}}{name}"
        for element in tree.iter():
            for attr, value in element.attrib.items():
                if value in ("/data/visit/script", "#form/visit/script"):
                    element.set(attr, value.removesuffix("script") + name)
    return etree.tostring(tree, encoding="unicode")
