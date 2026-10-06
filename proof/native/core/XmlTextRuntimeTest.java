package nova.compatibility;

import java.util.Arrays;
import java.util.Collection;
import java.nio.charset.StandardCharsets;
import org.javarosa.model.xform.XFormSerializingVisitor;
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
                assertText(form, "mixed_nbsp", "It's \"early\"\u00a0today");
                assertText(form, "consumer_spacing", meals
                    + "\t\n\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
                    + "14 Example Lane");
                assertText(form, "edge_whitespace", " \t" + meals + "\n 14 Example Lane\t ");
                assertText(form, "escaped_markup", "Literal <output value=\"'x'\"/> & #form/meals");
                FormEntryModel checkedEntry = at(form, "checked");
                FormEntryPrompt checked = checkedEntry.getQuestionPrompt();
                assertEquals(meals + "\n\n14 Example Lane", checked.getHintText());
                assertEquals(meals + "\n\n14 Example Lane",
                    checked.getSpecialFormQuestionText("checked-hint", FormEntryCaption.TEXT_FORM_MARKDOWN));
                assertEquals(meals + " 14 Example Lane", checked.getHelpText());
                assertEquals(meals + " 14 Example Lane",
                    checked.getSpecialFormQuestionText("checked-help", FormEntryCaption.TEXT_FORM_MARKDOWN));
                assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,
                    new FormEntryController(checkedEntry).answerQuestion(new StringData("bad")));
                assertEquals(meals + "\t14 Example Lane", checked.getConstraintText());
                assertEquals(meals + "\t14 Example Lane", checked.getConstraintText(new StringData("bad")));
                assertEquals(meals + "\t14 Example Lane",
                    checked.getConstraintText(FormEntryCaption.TEXT_FORM_MARKDOWN, null));
                FormEntryPrompt choose = at(form, "choose").getQuestionPrompt();
                assertEquals(meals + "\n\n14 Example Lane",
                    choose.getSelectChoiceText(choose.getSelectChoices().get(0)));
                assertEquals(meals + "\n\n14 Example Lane",
                    choose.getSelectItemMarkdownText(choose.getSelectChoices().get(0)));
            }
        }
    }

    @Test public void preservesLiteralAndReturnedMarkersWithLiveReferencesAndAttemptedSelf() throws Exception {
        FormDef form = open().getFormDef();
        for (String address : new String[]{"Address ${0} / ${00}", "Changed ${12} / ${not-a-number} ${"}) {
            assertEquals(FormEntryController.ANSWER_OK,
                new FormEntryController(at(form, "address")).answerQuestion(new StringData(address)));
            for (String locale : new String[]{"en", "es"}) {
                form.getLocalizer().setLocale(locale);
                FormEntryModel literalEntry = at(form, "literal_checked");
                assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,
                    new FormEntryController(literalEntry).answerQuestion(new IntegerData(99)));
                String literal = "es".equals(locale) ? "Español ${00} / ${0}" : "Literal ${0} / ${00}; It's \"early\"\u00a0today";
                assertEquals(literal, literalEntry.getQuestionPrompt().getConstraintText());
                assertEquals(literal, literalEntry.getQuestionPrompt().getConstraintText(FormEntryCaption.TEXT_FORM_MARKDOWN, null));
                FormEntryModel referenceEntry = at(form, "reference_checked");
                FormEntryPrompt reference = referenceEntry.getQuestionPrompt();
                assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED,
                    new FormEntryController(referenceEntry).answerQuestion(new IntegerData(99)));
                for (boolean attempted : new boolean[]{false, true}) {
                    int self = attempted ? 99 : 4;
                    String expected = "es".equals(locale) ? self + " Español ${00} / ${0}: " + address
                        : "Literal ${0} / ${00}: " + address + " | Self: " + self;
                    assertEquals(expected, reference.getConstraintText(attempted ? new IntegerData(99) : null));
                    assertEquals(expected, reference.getConstraintText(FormEntryCaption.TEXT_FORM_MARKDOWN, attempted ? new IntegerData(99) : null));
                }
                assertEquals("4", ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(/data/reference_checked)"));
            }
        }
        int asked = 0;
        FormEntryModel model = new FormEntryModel(form);
        FormEntryController controller = new FormEntryController(model);
        int events = 0;
        while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
            assertTrue(++events < 100);
            if (model.getEvent() == FormEntryController.EVENT_QUESTION) {
                asked++;
                assertFalse(model.getFormIndex().getReference().toString().contains("nova_constraint_message_"));
            }
        }
        assertEquals("Every authored question, no technical owner", 15, asked);
        for (String name : new String[]{"checked", "literal_checked", "reference_checked"}) {
            TreeElement owner = form.getMainInstance().getRoot().getChild("nova_constraint_message_" + name, 0);
            assertNotNull(owner); assertFalse(owner.isRelevant()); assertFalse(owner.isEnabled()); assertNull(owner.getValue());
            XPathNodeset visible = (XPathNodeset) XPathParseTool.parseXPath("/data/nova_constraint_message_" + name)
                .eval(form.getMainInstance(), form.getEvaluationContext());
            assertEquals(0, visible.size());
        }
        String submitted = new String(new XFormSerializingVisitor().serializeInstance(form.getMainInstance()), StandardCharsets.UTF_8);
        String raw = new String(new XFormSerializingVisitor(false).serializeInstance(form.getMainInstance()), StandardCharsets.UTF_8);
        assertFalse(submitted.contains("nova_constraint_message_"));
        for (String name : new String[]{"checked", "literal_checked", "reference_checked"})
            assertTrue(raw.contains("nova_constraint_message_" + name));
    }
}
