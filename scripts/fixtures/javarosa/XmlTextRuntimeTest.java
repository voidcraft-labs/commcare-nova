package nova.compatibility;

import java.util.Arrays;
import java.util.Collection;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/** Native runtime values, not merely acceptance of well-formed XML bytes. */
@RunWith(Parameterized.class)
public class XmlTextRuntimeTest {
    @Parameterized.Parameters(name = "{0}")
    public static Collection<Object[]> files() {
        return Arrays.asList(new Object[][]{{"unicode.xml"}, {"unicode.hq.xml"}});
    }
    private final String file;
    public XmlTextRuntimeTest(String file) { this.file = file; }

    @Test public void preservesInitialAnswerAndQuestionText() throws Exception {
        FormParseInit parsed = new FormParseInit("/" + file);
        FormDef form = parsed.getFormDef();
        form.initialize(true, new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                assertEquals("commcaresession", instance.getInstanceId());
                TreeElement session = new TreeElement("session", 0);
                TreeElement context = new TreeElement("context", 0);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion", "drift"}) {
                    TreeElement value = new TreeElement(key, 0);
                    value.setValue(new StringData("drift".equals(key) ? "0" : "fixture-" + key));
                    context.addChild(value);
                }
                session.addChild(context);
                InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(session);
            }
        });
        assertEquals("A\tB\nC\rD", ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(/data/answer)"));
        form.getLocalizer().setLocale("en");
        assertNotNull(parsed.getFirstQuestionDef());
        assertEquals("é é العربية 汉字 😀 \u007f\u0085\u009f", parsed.getFormEntryModel().getQuestionPrompt().getLongText());
    }
}
