package nova.compatibility;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.javarosa.core.model.FormDef;
import org.javarosa.xform.util.XFormUtils;
import org.junit.Test;
import static org.junit.Assert.*;
public class XFormOracleRuntimeTest {
    @Test public void exactWireCorpusMatchesActualCoreParserOutcomes() throws Exception {
        List<String> differences = new ArrayList<>();
        int total = 0;
        try (BufferedReader input = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/xform-cases.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = input.readLine()) != null) {
                String[] parts = line.split("\t");
                boolean accepted = false; String reason = "";
                try (InputStream xml = getClass().getResourceAsStream("/" + parts[0] + ".xml")) {
                    assertNotNull(parts[0], xml);
                    try { FormDef form = XFormUtils.getFormFromInputStream(xml); accepted = form != null; }
                    catch (RuntimeException exception) { reason = exception.getClass().getSimpleName() + ": " + exception.getMessage(); }
                }
                System.out.println(parts[0] + "\t" + accepted + "\t" + reason);
                if (accepted != Boolean.parseBoolean(parts[1])) differences.add(parts[0] + " expected " + parts[1] + " actual " + accepted + " " + reason);
                total++;
            }
        }
        assertEquals(67, total);
        assertEquals(Collections.emptyList(), differences);
    }

    private String basic() throws IOException {
        try (InputStream input = getClass().getResourceAsStream("/basic.xml")) { assertNotNull(input); return new String(input.readAllBytes(), StandardCharsets.UTF_8); }
    }
    private FormDef calculate(String expression, boolean declared) throws IOException {
        String source = basic().replace("<bind nodeset=\"/data/q\" type=\"string\"/>",
            (declared ? "<instance id=\"commcaresession\"><session xmlns=\"\"><data/><context/></session></instance>" : "") +
            "<bind nodeset=\"/data/q\" type=\"string\" calculate=\"" + expression + "\"/>");
        try (InputStream input = new ByteArrayInputStream(source.getBytes(StandardCharsets.UTF_8))) {
            FormDef form = XFormUtils.getFormFromInputStream(input); assertNotNull(form); form.initialize(true, null); return form;
        }
    }
    @Test public void missingSessionLeavesAndMissingInstanceHaveDifferentFailures() throws Exception {
        for (String path : Arrays.asList("data/absent", "context/absent")) {
            for (boolean wrap : new boolean[]{false, true}) {
                String expression = "instance('commcaresession')/session/" + path;
                if (wrap) expression = "string(" + expression + ")";
                try { calculate(expression, true); fail("Missing structural leaf must refuse scalar calculation"); }
                catch (org.javarosa.xpath.XPathTypeMismatchException expected) { assertTrue(expected.getMessage().contains(path)); }
            }
        }
        try { calculate("instance('commcaresession')/session/data/absent", false); fail("Undeclared session instance must refuse"); }
        catch (org.javarosa.xpath.XPathMissingInstanceException expected) { }
    }
}
