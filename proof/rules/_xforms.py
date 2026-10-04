"""What the XForm rules read of a form: its namespaces, its model and body, and the attributes HQ keeps.

A private helper of the rule modules (``proof.rules.unregistered_rules``
reads a module whose name starts with ``_`` as no rule). Nothing here
changes a form.
"""

from __future__ import annotations

XHTML = "http://www.w3.org/1999/xhtml"
XFORMS = "http://www.w3.org/2002/xforms"
JAVAROSA = "http://openrosa.org/javarosa"
VELLUM = "http://commcarehq.org/xforms/vellum"
CASE = "http://commcarehq.org/case/transaction/v2"


def tag(namespace, local):
    return f"{{{namespace}}}{local}"


def is_element(node):
    return isinstance(node.tag, str)


def is_xform(root):
    """Whether ``root`` is an XForm's ``h:html``."""
    return is_element(root) and root.tag == tag(XHTML, "html")


def model(root):
    """The form's model (``h:head/xf:model``), or None where the form has none."""
    if not is_xform(root):
        return None
    head = root.find(tag(XHTML, "head"))
    return None if head is None else head.find(tag(XFORMS, "model"))


def body(root):
    """The form's body (``h:body``), or None."""
    return root.find(tag(XHTML, "body")) if is_xform(root) else None


def own_attributes(element):
    """The element's attributes outside Vellum's namespace, which HQ removes before it builds
    (``xform.py::XForm.strip_vellum_ns_attributes``)."""
    return {key: value for key, value in element.attrib.items() if not key.startswith(f"{{{VELLUM}}}")}


# The attributes of a bind that Core builds into a triggerable, which it evaluates again whenever a node it reads
# changes (commcare-core ``XFormParser.processStandardBindAttributes``: a ``Condition`` for ``relevant``,
# ``required`` and ``readonly``, a ``Recalculate`` for ``calculate``).
TRIGGERABLE_ATTRIBUTES = ("relevant", "required", "readonly", "calculate")
# Every attribute of a bind Core parses as an expression as it reads the bind, in document order
# (``processStandardBindAttributes``): the triggerables' and the ``constraint``.
EXPRESSION_ATTRIBUTES = (*TRIGGERABLE_ATTRIBUTES, "constraint")


def bind_expressions(form_model, attributes=TRIGGERABLE_ATTRIBUTES):
    """Each expression the model's binds hold in ``attributes`` (by default, the triggerables'), as ``(bind,
    attribute, expression)``."""
    return [
        (bind, attribute, bind.get(attribute))
        for bind in form_model.findall(tag(XFORMS, "bind"))
        for attribute in attributes
        if bind.get(attribute) is not None
    ]
