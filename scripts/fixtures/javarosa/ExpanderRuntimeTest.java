package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.suite.model.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.services.locale.*;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.model.xform.XPathReference;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual Core parser over every admitted expander artifact, plus execution of
 * the HQ enum key replacement counterexample. Parsing alone is not runtime proof. */
public class ExpanderRuntimeTest {
 private InputStream resource(String name){InputStream in=getClass().getResourceAsStream("/"+name);assertNotNull(name,in);return in;}
 private List<String[]> records()throws Exception{
  List<String[]> rows=new ArrayList<>();
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(resource("expander-resources.tsv"),StandardCharsets.UTF_8))){String line;while((line=reader.readLine())!=null)rows.add(line.split("\t",-1));}
  assertTrue(rows.size()>70);return rows;
 }
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"expander-proof",null,true,true,false);}}
 private Suite suite(String id,boolean hq)throws Exception{try(InputStream in=resource(id+(hq?".hq-suite.xml":".suite.xml"))){return new Parser(in).parse();}}
 @After public void cleanup(){LocalizerManager.clearInstance();}
 @Test public void parsesEveryAdmittedLocalAndNativeHqArtifact()throws Exception{
  int suites=0,forms=0;
  for(String[] row:records())for(boolean hq:new boolean[]{false,true}){
   System.out.println("Parse expander source="+row[0]+" hq="+hq);
   assertNotNull(suite(row[0],hq));suites++;
   for(String filename:row[hq?2:1].split(",")){if(filename.isEmpty())continue;assertNotNull(filename,new FormParseInit("/"+filename).getFormDef());forms++;}
  }
  assertTrue(forms>140);System.out.println("Parsed expander suites="+suites+" forms="+forms);
 }
 @Test public void nativeHqEnumReplacementPreservesDoubleDigitOptionLabels()throws Exception{
  int checked=0;
  for(String[] row:records())if(row[3].equals("double-digit"))for(boolean hq:new boolean[]{false,true}){
   Hashtable<String,String> values;try(InputStream in=resource(row[0]+(hq?".hq":"")+".app_strings.txt")){values=LocalizationUtils.parseLocaleInput(in);}
   LocalizerManager.init(true);Localizer localizer=LocalizerManager.getGlobalLocalizer();localizer.addAvailableLocale("en");localizer.registerLocaleResource("en",new TableLocaleSource(values));localizer.setLocale("en");
   Suite suite=suite(row[0],hq);TreeElement root=new TreeElement("case",0),tags=new TreeElement("tags",0);tags.setValue(new StringData("tag_10"));root.addChild(tags);
   EvaluationContext context=new EvaluationContext(new FormInstance(root));EvaluationContext selected=new EvaluationContext(context,XPathReference.getPathExpr("/case").getReference());
   assertEquals("Tag 10",suite.getDetail("m0_case_short").getFields()[0].getTemplate().evaluate(selected));checked++;
  }
  assertEquals(2,checked);
 }
}
