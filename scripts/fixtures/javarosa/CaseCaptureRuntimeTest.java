package nova.compatibility;

import java.io.ByteArrayInputStream;
import javax.xml.parsers.DocumentBuilderFactory;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.w3c.dom.Document;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.FormIndex;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** Execute actual CCZ and HQ-regenerated forms, with only device data supplied. */
public class CaseCaptureRuntimeTest {
    private static TreeElement node(String name, String value) {
        TreeElement element = new TreeElement(name, 0);
        if (value != null) element.setValue(new StringData(value));
        return element;
    }
    private static InstanceInitializationFactory environment() {
        return new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if ("selected_cases".equals(instance.getInstanceId())) {
                    TreeElement root = node("results", null);
                    for (int index = 0; index < 2; index++) {
                        TreeElement value = new TreeElement("value", index);
                        value.setValue(new StringData("patient-" + index));
                        root.addChild(value);
                    }
                    InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                    return new ConcreteInstanceRoot(root);
                }
                if ("casedb".equals(instance.getInstanceId())) {
                    TreeElement root = node("casedb", null);
                    TreeElement patient = node("case", null);
                    patient.setAttribute(null, "case_id", "existing-patient-id");
                    patient.setAttribute(null, "case_type", "patient");
                    patient.addChild(node("case_name", "Existing patient"));
                    patient.addChild(node("photo", ""));
                    patient.addChild(node("scan_url", "https://example.org/previous.pdf"));
                    root.addChild(patient);
                    InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                    return new ConcreteInstanceRoot(root);
                }
                if (!"commcaresession".equals(instance.getInstanceId())) throw new AssertionError(instance.getInstanceId());
                TreeElement session = node("session", null);
                TreeElement context = node("context", null);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) context.addChild(node(key, "fixture-" + key));
                context.addChild(node("drift", "0"));
                TreeElement data = node("data", null);
                data.addChild(node("case_id_new_patient_0", "new-patient-id"));
                data.addChild(node("case_id", "existing-patient-id"));
                session.addChild(context);
                session.addChild(data);
                InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(session);
            }
        };
    }
    private static Object eval(FormDef form, String expression) throws Exception {
        return ExprEvalUtils.xpathEval(form.getEvaluationContext(), expression);
    }
    private static Document submission(FormDef form) throws Exception {
        byte[] xml = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }
    private static void answer(FormDef form, String path, String answer) throws Exception {
        XPathNodeset target = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals("Answer exactly one active question: " + path, 1, target.size());
        form.setValue(new StringData(answer), target.getRefAt(0));
    }
    private static void enter(FormParseInit parsed, String scenario) throws Exception {
        // Native entry traversal expands fixed repeats; a user-controlled
        // repeat is added only in response to its actual new-repeat event.
        FormEntryController controller = parsed.getFormEntryController();
        controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
        boolean created = false;
        int steps = 0;
        int event;
        while ((event = controller.stepToNextEvent()) != FormEntryController.EVENT_END_OF_FORM) {
            if (++steps > 50) throw new AssertionError("Form entry did not terminate");
            if (event == FormEntryController.EVENT_PROMPT_NEW_REPEAT && "repeat".equals(scenario) && !created) {
                controller.newRepeat();
                created = true;
            }
        }
    }
    private static void check(String scenario, boolean hq, String... scopes) throws Exception {
        FormParseInit parsed = new FormParseInit("/capture-" + scenario + (hq ? ".hq.xml" : ".xml"));
        FormDef form = parsed.getFormDef();
        form.initialize(true, environment());
        answer(form, "/data/show", "yes");
        if ("followup".equals(scenario)) {
            assertEquals("A case URL is not a captured file in this submission", "", eval(form, "/data/details/scan"));
        }
        enter(parsed, scenario);
        if ("repeat".equals(scenario)) assertEquals(1.0, eval(form, "count(/data/wounds)"));
        if ("query".equals(scenario)) assertEquals(2.0, eval(form, "count(/data/wounds/item)"));
        String instanceId = (String)eval(form, "/data/meta/instanceID");
        String prefix = "https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/" + instanceId + "/";
        for (int index = 0; index < scopes.length; index++) {
            String scope = scopes[index];
            answer(form, scope + ("/data".equals(scope) ? "/full_name" : "/site"), "Patient " + index);
            answer(form, scope + "/details/scan", "scan-" + index + ".pdf");
            answer(form, scope + "/details/thepicture", "photo-" + index + ".jpg");
            assertEquals(prefix + "scan-" + index + ".pdf", eval(form, scope + "/case/update/scan_url"));
            assertEquals("photo-" + index + ".jpg", eval(form, scope + "/case/attachment/photo/@src"));
        }
        answer(form, "/data/show", "no");
        for (String scope : scopes) {
            assertEquals(0.0, eval(form, "count(" + scope + "/details/scan)"));
            assertEquals("Hidden capture must preserve the existing case link", 0.0, eval(form, "count(" + scope + "/case/update/scan_url)"));
            assertEquals(0.0, eval(form, "count(" + scope + "/case/attachment/photo)"));
        }
        String caseNamespace = "http://commcarehq.org/case/transaction/v2";
        Document hiddenSubmission = submission(form);
        assertEquals(0, hiddenSubmission.getElementsByTagNameNS(caseNamespace, "scan_url").getLength());
        assertEquals(0, hiddenSubmission.getElementsByTagNameNS(caseNamespace, "photo").getLength());
        answer(form, "/data/show", "yes");
        for (int index = 0; index < scopes.length; index++) {
            assertEquals(prefix + "scan-" + index + ".pdf", eval(form, scopes[index] + "/case/update/scan_url"));
        }
        answer(form, scopes[0] + "/details/scan", "");
        assertEquals("Active blank is a real case-property clear", 1.0, eval(form, "count(" + scopes[0] + "/case/update/scan_url)"));
        assertEquals("", eval(form, scopes[0] + "/case/update/scan_url"));
        if (scopes.length > 1) assertEquals(prefix + "scan-1.pdf", eval(form, scopes[1] + "/case/update/scan_url"));
        Document clearedSubmission = submission(form);
        assertEquals(scopes.length, clearedSubmission.getElementsByTagNameNS(caseNamespace, "scan_url").getLength());
        assertEquals("", clearedSubmission.getElementsByTagNameNS(caseNamespace, "scan_url").item(0).getTextContent());
        if (scopes.length > 1) assertEquals(prefix + "scan-1.pdf", clearedSubmission.getElementsByTagNameNS(caseNamespace, "scan_url").item(1).getTextContent());
        if ("repeat".equals(scenario) || "query".equals(scenario)) {
            assertEquals(scopes.length, clearedSubmission.getElementsByTagNameNS(caseNamespace, "parent").getLength());
            for (int index = 0; index < scopes.length; index++) assertEquals("existing-patient-id", clearedSubmission.getElementsByTagNameNS(caseNamespace, "parent").item(index).getTextContent());
        }
    }
    private static void checkMultiple(boolean hq) throws Exception {
        FormParseInit parsed = new FormParseInit("/capture-multiple" + (hq ? ".hq.xml" : ".xml"));
        FormDef form = parsed.getFormDef();
        form.initialize(true, environment());
        answer(form, "/data/show", "yes");
        enter(parsed, "multiple");
        assertEquals(2.0, eval(form, "count(/data/__nova_selected_cases/item)"));
        answer(form, "/data/full_name", "Shared name");
        answer(form, "/data/details/scan", "shared.pdf");
        answer(form, "/data/details/thepicture", "shared.jpg");
        String namespace = "http://commcarehq.org/case/transaction/v2";
        String prefix = "https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/" + eval(form, "/data/meta/instanceID") + "/";
        Document active = submission(form);
        assertEquals(2, active.getElementsByTagNameNS(namespace, "case").getLength());
        Set<String> ids = new HashSet<>();
        for (int index = 0; index < 2; index++) {
            ids.add(((org.w3c.dom.Element)active.getElementsByTagNameNS(namespace, "case").item(index)).getAttribute("case_id"));
            assertEquals(prefix + "shared.pdf", active.getElementsByTagNameNS(namespace, "scan_url").item(index).getTextContent());
            assertEquals("shared.jpg", ((org.w3c.dom.Element)active.getElementsByTagNameNS(namespace, "photo").item(index)).getAttribute("src"));
        }
        assertEquals(new HashSet<>(Arrays.asList("patient-0", "patient-1")), ids);
        answer(form, "/data/show", "no");
        Document hidden = submission(form);
        assertEquals(2, hidden.getElementsByTagNameNS(namespace, "case_name").getLength());
        assertEquals(0, hidden.getElementsByTagNameNS(namespace, "scan_url").getLength());
        assertEquals(0, hidden.getElementsByTagNameNS(namespace, "photo").getLength());
        answer(form, "/data/show", "yes");
        answer(form, "/data/details/scan", "");
        Document blankUrl = submission(form);
        assertEquals("Blank shared values preserve every selected case", 0, blankUrl.getElementsByTagNameNS(namespace, "scan_url").getLength());
        assertEquals(2, blankUrl.getElementsByTagNameNS(namespace, "photo").getLength());
        answer(form, "/data/details/thepicture", "");
        answer(form, "/data/full_name", "");
        assertEquals("All blank shared answers omit every ordinary transaction", 0, submission(form).getElementsByTagNameNS(namespace, "case").getLength());
    }
    @Test public void multiple() throws Exception { checkMultiple(false); }
    @Test public void hqMultiple() throws Exception { checkMultiple(true); }
    @Test public void registration() throws Exception { check("registration", false, "/data"); }
    @Test public void followup() throws Exception { check("followup", false, "/data"); }
    @Test public void repeat() throws Exception { check("repeat", false, "/data/wounds[1]"); }
    @Test public void query() throws Exception { check("query", false, "/data/wounds/item[1]", "/data/wounds/item[2]"); }
    @Test public void hqRegistration() throws Exception { check("registration", true, "/data"); }
    @Test public void hqFollowup() throws Exception { check("followup", true, "/data"); }
    @Test public void hqRepeat() throws Exception { check("repeat", true, "/data/wounds[1]"); }
    @Test public void hqQuery() throws Exception { check("query", true, "/data/wounds/item[1]", "/data/wounds/item[2]"); }
}
