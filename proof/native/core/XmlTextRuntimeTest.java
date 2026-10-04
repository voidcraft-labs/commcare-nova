package nova.compatibility;

import java.util.Arrays;
import java.util.Collection;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.IntegerData;
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
import org.javarosa.form.api.FormEntryCaption;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.form.api.FormEntryModel;
import org.javarosa.form.api.FormEntryPrompt;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
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

    private FormParseInit open() throws Exception {
        FormParseInit parsed = new FormParseInit("/xml/" + file);
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
        form.getLocalizer().setLocale("en");
        return parsed;
    }

    @Test public void preservesInitialAnswerAndQuestionText() throws Exception {
        FormParseInit parsed = open();
        FormDef form = parsed.getFormDef();
        assertEquals("A\tB\nC\rD", ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(/data/answer)"));
        assertNotNull(parsed.getFirstQuestionDef());
        assertEquals("é é العربية 汉字 😀 \u007f\u0085\u009f", parsed.getFormEntryModel().getQuestionPrompt().getLongText());
    }

    private static FormEntryModel at(FormDef form, String path) throws Exception {
        XPathNodeset target = (XPathNodeset) XPathParseTool.parseXPath("/data/" + path)
            .eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals("One target question", 1, target.size());
        FormEntryModel model = new FormEntryModel(form);
        FormEntryController controller = new FormEntryController(model);
        int events = 0;
        while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
            assertTrue("Bounded authored form", ++events < 100);
            if (model.getEvent() == FormEntryController.EVENT_QUESTION
                    && model.getFormIndex().getReference().equals(target.getRefAt(0))) return model;
        }
        throw new AssertionError("Missing question " + path);
    }

    private static void assertText(FormDef form, String path, String expected) throws Exception {
        FormEntryPrompt prompt = at(form, path).getQuestionPrompt();
        assertEquals(path + " plain text", expected, prompt.getQuestionText());
        assertEquals(path + " Markdown", expected, prompt.getMarkdownText());
    }

    @Test public void preservesSeparatorsAfterOutputSubstitution() throws Exception {
        FormDef form = open().getFormDef();
        for (int meals : new int[]{1, 3}) {
            FormEntryModel entry = at(form, "meals");
            assertEquals(FormEntryController.ANSWER_OK,
                new FormEntryController(entry).answerQuestion(new IntegerData(meals)));
            for (String locale : new String[]{"en", "es"}) {
                form.getLocalizer().setLocale(locale);
                assertText(form, "delivery_context", ("es".equals(locale) ? "Comidas: " : "Meals: ")
                    + meals + "\n\n14 Example Lane");
                assertText(form, "space", meals + " 14 Example Lane");
                assertText(form, "xml_whitespace", meals + "\t \r\n14 Example Lane");
                assertText(form, "unicode_spacing", meals + "\u00a0\u2003\u202814 Example Lane");
                assertText(form, "edge_whitespace", " \t" + meals + "\n 14 Example Lane\t ");
                assertText(form, "escaped_markup", "Literal <output value=\"'x'\"/> & #form/meals");
                FormEntryPrompt checked = at(form, "checked").getQuestionPrompt();
                assertEquals(meals + "\n\n14 Example Lane", checked.getHintText());
                assertEquals(meals + "\n\n14 Example Lane",
                    checked.getSpecialFormQuestionText("checked-hint", FormEntryCaption.TEXT_FORM_MARKDOWN));
                assertEquals(meals + " 14 Example Lane", checked.getHelpText());
                assertEquals(meals + " 14 Example Lane",
                    checked.getSpecialFormQuestionText("checked-help", FormEntryCaption.TEXT_FORM_MARKDOWN));
                // The legacy jr:constraintMsg getter returns an itext template,
                // without output substitution. Its emitted separators are
                // checked in test_xml_boundary; this test claims only the
                // prompt APIs that actually substitute outputs.
                FormEntryPrompt choose = at(form, "choose").getQuestionPrompt();
                assertEquals(meals + "\n\n14 Example Lane",
                    choose.getSelectChoiceText(choose.getSelectChoices().get(0)));
                assertEquals(meals + "\n\n14 Example Lane",
                    choose.getSelectItemMarkdownText(choose.getSelectChoices().get(0)));
            }
        }
    }
}
