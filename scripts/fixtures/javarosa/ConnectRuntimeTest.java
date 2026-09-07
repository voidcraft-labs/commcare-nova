package nova.compatibility;

import java.io.ByteArrayInputStream;
import org.commcare.cases.model.Case;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import java.util.Arrays;
import java.util.Collection;
import javax.xml.parsers.DocumentBuilderFactory;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.IntegerData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.w3c.dom.Document;
import static org.junit.Assert.*;

/** Execute calculated Connect payloads and namespace-preserving submissions. */
@RunWith(Parameterized.class)
public class ConnectRuntimeTest {
    private static final String NS = "http://commcareconnect.com/data/v1/learn";
    @Parameterized.Parameters(name = "{0}{1}")
    public static Collection<Object[]> files() {
        return Arrays.asList(new Object[][]{
            {"learn-default", ".xml"}, {"learn-custom", ".xml"},
            {"deliver-default", ".xml"}, {"deliver-custom", ".xml"}, {"absent", ".xml"},
            {"learn-default", ".hq.xml"}, {"learn-custom", ".hq.xml"},
            {"deliver-default", ".hq.xml"}, {"deliver-custom", ".hq.xml"}, {"absent", ".hq.xml"}
        });
    }
    private final String name;
    private final String suffix;
    public ConnectRuntimeTest(String name, String suffix) { this.name = name; this.suffix = suffix; }
    private static Object value(FormDef form, String path) throws Exception {
        return ExprEvalUtils.xpathEval(form.getEvaluationContext(), path);
    }
    private static Document submission(FormDef form) throws Exception {
        byte[] xml = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml));
    }
    private static TreeReference ref(FormDef form, String path) throws Exception {
        XPathNodeset selected = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals(1, selected.size());
        return selected.getRefAt(0);
    }
    @Test public void executesConfiguredValuesAndSerializesConnectNamespace() throws Exception {
        FormDef form = new FormParseInit("/" + name + suffix).getFormDef();
        MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        for (String id : new String[]{"worker", "wrong-user", "wrong-type"}) {
            Case record = new Case(id, "wrong-type".equals(id) ? "patient" : "commcare-user");
            record.setCaseId(id);
            record.setProperty("hq_user_id", "wrong-user".equals(id) ? "other-user" : "fixture-userid");
            record.setProperty("username", "worker".equals(id) ? "worker-short-name" : "wrong");
            sandbox.getCaseStorage().write(record);
        }
        form.initialize(true, new TestInstanceInitializer(sandbox) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                TreeElement session = new TreeElement("session", 0);
                TreeElement context = new TreeElement("context", 0);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion", "drift"}) {
                    TreeElement node = new TreeElement(key, 0);
                    node.setValue(new StringData("drift".equals(key) ? "0" : "fixture-" + key));
                    context.addChild(node);
                }
                session.addChild(context);
                InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), instance.getBase());
                return new ConcreteInstanceRoot(session);
            }
        });
        if (name.startsWith("learn")) {
            String expected = name.endsWith("custom") ? "42" : "100";
            assertEquals(expected, value(form, "string(/data/quiz/assessment/user_score)"));
            assertEquals(expected, submission(form).getElementsByTagNameNS(NS, "user_score").item(0).getTextContent());
            assertEquals("Health & care <雪>", submission(form).getElementsByTagNameNS(NS, "name").item(0).getTextContent());
            form.setValue(new IntegerData(73), ref(form, "/data/score"));
            assertEquals(name.endsWith("custom") ? "73" : "100", value(form, "string(/data/quiz/assessment/user_score)"));
        } else if (name.startsWith("deliver")) {
            String expected = name.endsWith("custom") ? "visit-42" : (String)value(form, "concat('worker-short-name-', today())");
            assertEquals(expected, value(form, "string(/data/visit/deliver/entity_id)"));
            assertEquals(name.endsWith("custom") ? "Clinic & child" : "worker-short-name", value(form, "string(/data/visit/deliver/entity_name)"));
            assertEquals(expected, submission(form).getElementsByTagNameNS(NS, "entity_id").item(0).getTextContent());
            assertEquals(1, submission(form).getElementsByTagNameNS(NS, "task").getLength());
            form.setValue(new IntegerData(73), ref(form, "/data/score"));
            form.setValue(new StringData("Changed <雪>"), ref(form, "/data/feedback"));
            assertEquals(name.endsWith("custom") ? "visit-73" : expected, value(form, "string(/data/visit/deliver/entity_id)"));
            assertEquals(name.endsWith("custom") ? "Changed <雪>" : "worker-short-name", submission(form).getElementsByTagNameNS(NS, "entity_name").item(0).getTextContent());
        } else {
            assertEquals(0, submission(form).getElementsByTagNameNS(NS, "*").getLength());
        }
    }
}
