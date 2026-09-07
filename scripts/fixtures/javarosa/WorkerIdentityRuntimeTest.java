package nova.compatibility;
import java.io.*;
import org.commcare.cases.model.Case;
import org.commcare.session.CommCareSession;
import org.commcare.util.CommCarePlatform;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.suite.model.Suite;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.xpath.expr.FunctionUtils;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real case database filters plus separate menu-session worker data. */
public class WorkerIdentityRuntimeTest {
 private static TreeElement node(String name,String value){TreeElement n=new TreeElement(name,0);if(value!=null)n.setValue(new StringData(value));return n;}
 private static final class Runtime extends CommCareInstanceInitializer {
  final MockUserDataSandbox sandbox;final String slug,menuValue;
  Runtime(String slug,String menuValue,String caseValue)throws Exception{this(MockDataUtils.getStaticStorage(),slug,menuValue,caseValue);}
  private Runtime(MockUserDataSandbox sandbox,String slug,String menuValue,String caseValue)throws Exception{
   super(sandbox);this.sandbox=sandbox;this.slug=slug;this.menuValue=menuValue;
   for(String id:new String[]{"correct","other-user","wrong-type"}){
    Case record=new Case(id,id.equals("wrong-type")?"patient":"commcare-user");record.setCaseId(id);record.setProperty("hq_user_id",id.equals("other-user")?"other-worker":"worker");record.setProperty(slug,id.equals("correct")?caseValue:"n");sandbox.getCaseStorage().write(record);
   }
  }
  @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance){
   TreeElement root=node("session",null),context=node("context",null),user=node("user",null),data=node("data",null);
   context.addChild(node("userid","worker"));for(String key:new String[]{"deviceid","username","appversion"})context.addChild(node(key,"fixture-"+key));context.addChild(node("drift","0"));data.addChild(node(slug,menuValue));user.addChild(data);root.addChild(context);root.addChild(user);
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 private static final class Parser extends SuiteParser{Parser(InputStream input,Runtime runtime)throws IOException{super(input,null,"worker-wire",runtime.sandbox.getAppFixtureStorage(),true,false,false);}}
 @Test public void menuAndFormResolveTheNamedPropertyInTheirNativeContext()throws Exception{
  for(String slug:new String[]{"is_supervisor","district-code","supervision_status"})for(boolean hq:new boolean[]{false,true})for(String menuValue:new String[]{"n","y"})for(String caseValue:new String[]{"n","y"}){
   Runtime runtime=new Runtime(slug,menuValue,caseValue);Suite suite;
   try(InputStream input=getClass().getResourceAsStream("/worker-"+slug+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(input);suite=new Parser(input,runtime).parse();}
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);
   CommCareSession session=new CommCareSession(platform);
   EvaluationContext menuContext=session.getEvaluationContext(runtime,"m0",null);
   assertEquals(menuValue.equals("n"),FunctionUtils.toBoolean(suite.getMenus().firstElement().getMenuRelevance().eval(menuContext)));
   FormParseInit parsed=new FormParseInit("/worker-"+slug+(hq?".hq.xml":".xml"));parsed.getFormDef().initialize(true,runtime);
   FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());int count=0,steps=0;
   while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM){if(++steps>20)throw new AssertionError("Unexpected traversal");if(parsed.getFormEntryModel().getEvent()==FormEntryController.EVENT_QUESTION)count++;}
   assertEquals(slug+" menu="+menuValue+" case="+caseValue,caseValue.equals("n")?1:0,count);
  }
 }
}
