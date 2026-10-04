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
import org.javarosa.model.xform.XPathReference;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** Execution of the HQ enum key replacement counterexample from the admitted
 * expander corpus: a case list column over eleven options, on Nova's suite and
 * HQ's regeneration. That Core admits every expander export, local and HQ-built,
 * is the checks' (proof/checks/bar.py). */
public class ExpanderRuntimeTest {
 private InputStream resource(String name){InputStream in=getClass().getResourceAsStream("/expander/"+name);assertNotNull(name,in);return in;}
 private List<String> doubleDigit()throws Exception{
  List<String> ids=new ArrayList<>();
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(resource("double-digit.txt"),StandardCharsets.UTF_8))){String line;while((line=reader.readLine())!=null)if(!line.isEmpty())ids.add(line);}
  return ids;
 }
 private static final class Parser extends SuiteParser{Parser(InputStream in)throws IOException{super(in,null,"expander-proof",null,true,true,false);}}
 private Suite suite(String id,boolean hq)throws Exception{try(InputStream in=resource(id+(hq?".hq-suite.xml":".suite.xml"))){return new Parser(in).parse();}}
 @After public void cleanup(){LocalizerManager.clearInstance();}
 @Test public void nativeHqEnumReplacementPreservesDoubleDigitOptionLabels()throws Exception{
  int checked=0;
  for(String id:doubleDigit())for(boolean hq:new boolean[]{false,true}){
   Hashtable<String,String> values;try(InputStream in=resource(id+(hq?".hq":"")+".app_strings.txt")){values=LocalizationUtils.parseLocaleInput(in);}
   LocalizerManager.init(true);Localizer localizer=LocalizerManager.getGlobalLocalizer();localizer.addAvailableLocale("en");localizer.registerLocaleResource("en",new TableLocaleSource(values));localizer.setLocale("en");
   Suite suite=suite(id,hq);TreeElement root=new TreeElement("case",0),tags=new TreeElement("tags",0);tags.setValue(new StringData("tag_10"));root.addChild(tags);
   EvaluationContext context=new EvaluationContext(new FormInstance(root));EvaluationContext selected=new EvaluationContext(context,XPathReference.getPathExpr("/case").getReference());
   assertEquals("Tag 10",suite.getDetail("m0_case_short").getFields()[0].getTemplate().evaluate(selected));checked++;
  }
  assertEquals(2,checked);
 }
}
