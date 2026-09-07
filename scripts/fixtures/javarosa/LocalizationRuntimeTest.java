package nova.compatibility;
import java.io.*;
import java.util.*;
import org.commcare.suite.model.*;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.*;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.services.locale.*;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.*;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual Core locale parser, SuiteParser text resolution and form prompt APIs.
 * The fixture supplies session metadata only; no Android rendering is claimed. */
public class LocalizationRuntimeTest {
 private static final String[] SCENARIOS={"bilingual","mandarin","optional","escaped","stale","prompts"};
 private InputStream resource(String name) {InputStream input=getClass().getResourceAsStream("/locale-"+name);assertNotNull(name,input);return input;}
 private Hashtable<String,String> strings(String scenario,String lang,boolean hq)throws Exception {
  try(InputStream input=resource(scenario+(hq?".hq":"")+"."+lang+".strings.txt")){return LocalizationUtils.parseLocaleInput(input);}
 }
 private static String[] languages(String scenario){return "mandarin".equals(scenario)?new String[]{"en","cmn-hans","cmn-hant"}:new String[]{"es","en"};}
 private static String title(String scenario,String lang){
  if("cmn-hans".equals(lang))return "健康应用";
  if("cmn-hant".equals(lang))return "健康應用";
  if("optional".equals(scenario))return "Target-only prose";
  if("prompts".equals(scenario)||"stale".equals(scenario)||"en".equals(lang))return "Health app";
  return "escaped".equals(scenario)?"Aplicación #1\nSegunda línea":"Aplicación de salud";
 }
 private void localize(Hashtable<String,String> values,String lang){
  LocalizerManager.init(true);Localizer localizer=LocalizerManager.getGlobalLocalizer();
  localizer.addAvailableLocale(lang);localizer.registerLocaleResource(lang,new TableLocaleSource(values));localizer.setLocale(lang);
 }
 @After public void cleanup(){LocalizerManager.clearInstance();}
 private static final class Parser extends SuiteParser {
  Parser(InputStream input)throws IOException{super(input,null,"nova-localization",MockDataUtils.getStaticStorage().getAppFixtureStorage(),true,false,false);}
 }
 private Suite suite(String scenario,boolean hq)throws Exception{try(InputStream input=resource(scenario+(hq?".hq-suite.xml":".suite.xml"))){return new Parser(input).parse();}}
 @Test public void deliveredLocaleFilesResolveTitlesNamesAndNamedDefaults()throws Exception{
  for(String scenario:SCENARIOS)for(boolean hq:new boolean[]{false,true})for(String lang:languages(scenario)){
   Hashtable<String,String> values=strings(scenario,lang,hq);localize(values,lang);
   assertEquals(scenario+lang,title(scenario,lang),Localization.get("homescreen.title"));
   assertEquals(title(scenario,lang),Localization.get("app.display.name"));
   assertEquals(lang,Localization.get("lang.current"));
   for(String code:languages(scenario))assertEquals("en".equals(code)?"English":"es".equals(code)?"Español":"cmn-hans".equals(code)?"简体中文":"繁體中文",Localization.get(code));
   Suite suite=suite(scenario,hq);
   assertEquals("es".equals(lang)&&!"optional".equals(scenario)&&!"prompts".equals(scenario)?"Pacientes":"Patients",suite.getMenus().firstElement().getName().evaluate());
   if(!hq)assertEquals(strings(scenario,languages(scenario)[0],false),strings(scenario,"default",false));
  }
 }
 private static TreeElement node(String name,String value){TreeElement n=new TreeElement(name,0);if(value!=null)n.setValue(new StringData(value));return n;}
 private static InstanceInitializationFactory environment(){return new InstanceInitializationFactory(){
  @Override public InstanceRoot generateRoot(ExternalDataInstance instance){
   if(!"commcaresession".equals(instance.getInstanceId()))throw new AssertionError(instance.getInstanceId());
   TreeElement root=node("session",null),context=node("context",null),data=node("data",null);
   for(String key:new String[]{"deviceid","username","userid","appversion"})context.addChild(node(key,"fixture-"+key));
   context.addChild(node("drift","0"));data.addChild(node("case_id_new_patient_0","new-patient"));root.addChild(context);root.addChild(data);
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),new InstanceBase(instance.getInstanceId()));return new ConcreteInstanceRoot(root);
  }
 };}
 @Test public void nativeFormPromptsChangeLocaleAndKeepTargetOnlyContent()throws Exception{
  for(String scenario:SCENARIOS)for(boolean hq:new boolean[]{false,true}){
   FormParseInit parsed=new FormParseInit("/locale-"+scenario+(hq?".hq.xml":".xml"));
   FormDef form=parsed.getFormDef();form.initialize(true,environment());
   assertEquals(languages(scenario)[0],form.getLocalizer().getDefaultLocale());
   for(String lang:languages(scenario)){
    form.getLocalizer().setLocale(lang);
    FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
    int questions=0,steps=0;
    while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM){
     if(++steps>20)throw new AssertionError("Unexpected form traversal");
     if(parsed.getFormEntryModel().getEvent()!=FormEntryController.EVENT_QUESTION)continue;
     FormEntryPrompt prompt=parsed.getFormEntryModel().getQuestionPrompt();questions++;
     String expected="cmn-hans".equals(lang)?"名称":"cmn-hant".equals(lang)?"名稱":"es".equals(lang)&&!"optional".equals(scenario)&&!"prompts".equals(scenario)?"Nombre":"Name";
     assertEquals(scenario+lang,expected,prompt.getLongText());
     if("optional".equals(scenario)&&"es".equals(lang)){
      assertEquals("Pista",prompt.getHintText());assertEquals("Ayuda",prompt.getHelpText());assertEquals("Obligatorio",prompt.getConstraintText());
     }
    }
    assertEquals(1,questions);
   }
  }
 }
 @Test public void searchPromptChildrenResolveTheirOwnLocalizedText()throws Exception{
  for(boolean hq:new boolean[]{false,true})for(String lang:new String[]{"es","en"}){
   localize(strings("prompts",lang,hq),lang);Suite suite=suite("prompts",hq);
   Entry entry=suite.getEntry("search_command.m0");assertNotNull(entry);
   RemoteQueryDatum query=null;for(SessionDatum datum:entry.getSessionDataReqs())if(datum instanceof RemoteQueryDatum)query=(RemoteQueryDatum)datum;
   assertNotNull(query);EvaluationContext context=new EvaluationContext(null);
   QueryPrompt name=query.getUserQueryPrompts().get("case_name"),phone=query.getUserQueryPrompts().get("phone"),status=query.getUserQueryPrompts().get("status");
   assertEquals("es".equals(lang)?"Nombre y apellido":"First and last name",name.getDisplay().getHintText().evaluate(context));
   assertEquals("es".equals(lang)?"Indique un teléfono cuando falte el nombre.":"Give a phone when the name is blank.",phone.getRequiredMessage(context));
   assertEquals("Use solo letras minúsculas. Quite las comillas.",strings("prompts","es",hq).get("search_property.m0.status.validation.0.text"));
   if("es".equals(lang))assertEquals("Use solo letras minúsculas. Quite las comillas.",status.getValidationMessage(context));
  }
 }
}
