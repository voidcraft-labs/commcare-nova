package nova.proof.core;

import org.javarosa.xform.parse.XFormParseException;
import org.javarosa.xform.parse.XFormParser;
import org.javarosa.xform.schema.JSONReporter;
import org.javarosa.xpath.XPathException;

import java.io.StringReader;

/**
 * The form check HQ's build asks Formplayer for. The body of {@link #validate}
 * is Formplayer's UtilController.validateForm at the pinned Formplayer commit,
 * statement for statement: Core's XFormParser with a JSONReporter attached,
 * returning the reporter's JSON text unparsed, so HQ's ValidationAPIResult reads
 * exactly the bytes Formplayer would send. Formplayer's only other statement,
 * its log line for an unexpected exception, goes to the request's captured log.
 *
 * Formplayer decodes the posted body as UTF-8 (Spring's StringHttpMessageConverter
 * default charset), and so does the caller of this class.
 */
final class ValidateForm {
    private ValidateForm() {
    }

    static String validate(String formXML) throws Exception {
        JSONReporter reporter = new JSONReporter();
        try {
            XFormParser parser = new XFormParser(new StringReader(formXML));
            parser.attachReporter(reporter);
            parser.parse();
            reporter.setPassed();
        } catch (XFormParseException | XPathException xfpe) {
            reporter.setFailed(xfpe);
        } catch (Exception e) {
            System.err.println("Validate Form threw exception");
            e.printStackTrace();
            reporter.setFailed(e);
        }

        return reporter.generateJSONReport();
    }
}
