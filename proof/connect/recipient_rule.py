"""The repeat, recipient constraint and Connect calculation used by both worker readers."""

from lxml import etree

XFORMS = "http://www.w3.org/2002/xforms"
JR = "http://openrosa.org/javarosa"
CONNECT = "http://commcareconnect.com/data/v1/learn"
DOCUMENT = "targeted-validated-barcode-secret"


def source(original, skip_unchanged, *, confirmation=False, calculated=False, bounded=False):
    root = etree.fromstring(original.encode() if isinstance(original, str) else original)
    model, = root.xpath("//*[local-name()='model']")
    instance, = model.xpath("./*[local-name()='instance' and not(@id)]")
    data = instance[0]
    for child in list(data):
        data.remove(child)
    for child in list(model):
        if child is not instance:
            model.remove(child)
    body, = root.xpath("//*[local-name()='body']")
    for child in list(body):
        body.remove(child)

    ns = etree.QName(data).namespace
    rows = etree.SubElement(data, f"{{{ns}}}rows", {f"{{{JR}}}template": ""})
    etree.SubElement(rows, f"{{{ns}}}recipient")
    wrapper = etree.SubElement(rows, f"{{{ns}}}visit", {"{http://commcarehq.org/xforms/vellum}role": "ConnectDeliverUnit"})
    unit = etree.SubElement(wrapper, f"{{{CONNECT}}}deliver", id="visit", nsmap={None: CONNECT})
    for name in ("name", "entity_id", "entity_name", "work_area_id"):
        leaf = etree.SubElement(unit, f"{{{CONNECT}}}{name}")
        if name == "name":
            leaf.text = "Visit"
    path = "/data/rows[true()]/visit/deliver/entity_id" if calculated else "/data/rows[true()]/recipient"
    unique = f"string-length(join('|', {path})) = string-length(join('|', distinct-values({path})))"
    if bounded:
        unique = rf"({unique}) and regex(., '\A(?s:.{{0,255}})\z')"
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/rows/recipient",
                     type="string", required="true()", constraint=unique)
    etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/rows/visit/deliver/entity_id",
                     calculate="substr(../../../recipient, 0, 1)" if calculated else "../../../recipient")
    itext = etree.SubElement(model, f"{{{XFORMS}}}itext")
    language = etree.SubElement(itext, f"{{{XFORMS}}}translation", lang="en", default="")
    for key, value in [("rows", "Visit"), ("recipient", "Recipient ID")]:
        label = etree.SubElement(language, f"{{{XFORMS}}}text", id=key)
        etree.SubElement(label, f"{{{XFORMS}}}value").text = value
    if skip_unchanged:
        pragma = etree.SubElement(language, f"{{{XFORMS}}}text", id="Pragma-Skip-Full-Form-Validation")
        etree.SubElement(pragma, f"{{{XFORMS}}}value").text = "yes"
    group = etree.SubElement(body, f"{{{XFORMS}}}group")
    etree.SubElement(group, f"{{{XFORMS}}}label", ref="jr:itext('rows')")
    repeat = etree.SubElement(group, f"{{{XFORMS}}}repeat", nodeset="/data/rows")
    control = etree.SubElement(repeat, f"{{{XFORMS}}}input", ref="/data/rows/recipient")
    etree.SubElement(control, f"{{{XFORMS}}}label", ref="jr:itext('recipient')")
    if confirmation:
        etree.SubElement(data, f"{{{ns}}}confirmed")
        etree.SubElement(model, f"{{{XFORMS}}}bind", nodeset="/data/confirmed", type="string")
        control = etree.SubElement(body, f"{{{XFORMS}}}input", ref="/data/confirmed")
        etree.SubElement(control, f"{{{XFORMS}}}label").text = "Confirm"
    return etree.tostring(root, encoding="unicode")
