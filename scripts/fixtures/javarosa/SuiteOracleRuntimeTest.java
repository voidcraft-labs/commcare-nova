package nova.compatibility;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.xml.SuiteParser;
import org.commcare.suite.model.*;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.CommCarePlatform;
import org.commcare.session.CommCareSession;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.javarosa.core.services.locale.*;
import org.javarosa.core.util.NoLocalizedTextException;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

public class SuiteOracleRuntimeTest {
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "oracle", MockDataUtils.getStaticStorage().getAppFixtureStorage(), true, false, false); }
    }
    private Suite parse(String source) throws Exception {
        try (InputStream stream = new ByteArrayInputStream(source.getBytes(StandardCharsets.UTF_8))) { return new Parser(stream).parse(); }
    }
    private Suite parseFile(String name) throws Exception {
        try (InputStream stream = getClass().getResourceAsStream("/"+name+".suite.xml")) { assertNotNull(name, stream); return new Parser(stream).parse(); }
    }
    @Test public void externalWireCorpusUsesActualParserAndFixtureInstallation() throws Exception {
        List<String> differences = new ArrayList<>(); int count=0;
        try (BufferedReader input = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/suite-cases.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line=input.readLine())!=null) {
                String[] parts=line.split("\t"); boolean accepted=false; String reason="";
                try { accepted=parseFile(parts[0])!=null; }
                catch(Exception failure) { reason=failure.getClass().getSimpleName()+": "+failure.getMessage(); }
                System.out.println(parts[0]+"\t"+accepted+"\t"+reason);
                if(accepted!=Boolean.parseBoolean(parts[1])) differences.add(parts[0]+" expected "+parts[1]+" actual "+accepted+" "+reason);
                count++;
            }
        }
        assertTrue(count > 70);
        assertEquals(Collections.emptyList(), differences);
    }
    @Test public void caseTitleNeedsAnActualLocaleMapping() throws Exception {
        Localizer localizer=Localization.getGlobalLocalizerAdvanced();
        TableLocaleSource table=new TableLocaleSource();
        localizer.addAvailableLocale("oracle"); localizer.registerLocaleResource("oracle",table); localizer.setLocale("oracle");
        Detail detail=parseFile("locale-case-is-not-built-in").getDetail("d");
        try { detail.getTitle().getText().evaluate(); fail("No ambient cchq.case mapping"); }
        catch(NoLocalizedTextException expected) { assertTrue(expected.getMessage().contains("cchq.case")); }
        table.setLocaleMapping("cchq.case","Cases");
        localizer.registerLocaleResource("oracle",table); localizer.setLocale("oracle");
        assertEquals("Cases",detail.getTitle().getText().evaluate());
    }
    @Test public void admittedCompiledCaseTitleRendersFromDeliveredStrings() throws Exception {
        Properties values=new Properties();
        try(Reader reader=new InputStreamReader(getClass().getResourceAsStream("/admitted-case-title.strings.properties"),StandardCharsets.UTF_8)){values.load(reader);}
        TableLocaleSource table=new TableLocaleSource();
        for(String key:values.stringPropertyNames())table.setLocaleMapping(key,values.getProperty(key));
        Localizer localizer=Localization.getGlobalLocalizerAdvanced();
        localizer.addAvailableLocale("admitted");localizer.registerLocaleResource("admitted",table);localizer.setLocale("admitted");
        Suite suite=parseFile("admitted-case-title");
        assertEquals("Case",suite.getDetail("m0_case_short").getTitle().getText().evaluate());
        assertEquals("Case",suite.getDetail("m0_case_long").getTitle().getText().evaluate());
    }
    @Test public void freshSessionDoesNotInventUndeclaredInstances() throws Exception {
        Suite suite=parse("<suite version=\"1\"><entry><command id=\"c\"><text>Entry</text></command></entry></suite>");
        CommCarePlatform platform=new CommCarePlatform(2,53,0); platform.registerSuite(suite);
        CommCareSession session=new CommCareSession(platform); session.setCommand("c");
        EvaluationContext context=session.getEvaluationContext(new TestInstanceInitializer(MockDataUtils.getStaticStorage()));
        for(String id:Arrays.asList("casedb","commcaresession","results","results:inline","search-input:results","search-input:results:inline")) {
            try { ExprEvalUtils.xpathEval(context,"count(instance('"+id+"')/*)"); fail("Unexpected ambient instance "+id); }
            catch(org.javarosa.xpath.XPathMissingInstanceException expected) { }
        }
    }
}
