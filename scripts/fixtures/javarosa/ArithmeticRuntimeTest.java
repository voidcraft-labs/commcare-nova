package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collection;
import org.commcare.cases.model.Case;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.IntegerData;
import org.javarosa.core.model.data.DecimalData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** The production-exported, validator-admitted document writes actual cases. */
@RunWith(Parameterized.class)
public class ArithmeticRuntimeTest {
    @Parameterized.Parameters(name = "{0} / {1}")
    public static Collection<Object[]> inputs() {
        return Arrays.asList(new Object[][]{{10, 3, 3, 1}, {-10, 3, -3, -1}, {10, -3, -3, 1}, {-10, -3, 3, -1}});
    }
    private final int numerator, denominator, quotient, remainder;
    public ArithmeticRuntimeTest(int a, int b, int q, int r) { numerator=a; denominator=b; quotient=q; remainder=r; }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    @Test public void admittedFormStoresTypedArithmetic() throws Exception {
        MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        Case initial = new Case("Ada", "patient");
        initial.setCaseId("patient-1");
        initial.setUserId("worker-1");
        sandbox.getCaseStorage().write(initial);
        FormDef form = new FormParseInit("/arithmetic.xml").getFormDef();
        form.initialize(true, new TestInstanceInitializer(sandbox) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                TreeElement session = node("session", null);
                TreeElement context = node("context", null);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) context.addChild(node(key, "worker-1"));
                context.addChild(node("drift", "0"));
                TreeElement data = node("data", null);
                data.addChild(node("case_id", "patient-1"));
                session.addChild(context); session.addChild(data);
                InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(session);
            }
        });
        for (String path : new String[]{"numerator", "denominator", "decimal"}) {
            XPathNodeset nodes = (XPathNodeset)XPathParseTool.parseXPath("/data/" + path).eval(form.getMainInstance(), form.getEvaluationContext());
            assertEquals(1, nodes.size());
            form.setValue("decimal".equals(path) ? new DecimalData(10.0) : new IntegerData("numerator".equals(path) ? numerator : denominator), nodes.getRefAt(0));
        }
        form.postProcessInstance();
        byte[] submitted = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
        XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submitted));
        Case stored = sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
        assertEquals(Integer.toString(quotient), stored.getPropertyString("quotient"));
        assertEquals(Integer.toString(remainder), stored.getPropertyString("remainder"));
        assertEquals("715827882", stored.getPropertyString("large"));
        assertEquals(10.0 / denominator, Double.parseDouble(stored.getPropertyString("mixed")), 1e-14);
        assertEquals(1, sandbox.getCaseStorage().getNumRecords());

        String[] zeroExpressions;
        try (InputStream stream = getClass().getResourceAsStream("/arithmetic-zero.txt")) {
            assertNotNull(stream);
            zeroExpressions = new String(stream.readAllBytes(), StandardCharsets.UTF_8).split("\\n");
        }
        assertEquals(Double.POSITIVE_INFINITY, (Double)ExprEvalUtils.xpathEval(form.getEvaluationContext(), zeroExpressions[0]), 0);
        assertEquals(Double.NEGATIVE_INFINITY, (Double)ExprEvalUtils.xpathEval(form.getEvaluationContext(), zeroExpressions[1]), 0);
        assertTrue(Double.isNaN((Double)ExprEvalUtils.xpathEval(form.getEvaluationContext(), zeroExpressions[2])));
    }
}
