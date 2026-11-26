package nova.compatibility;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.commcare.cases.model.Case;
import org.commcare.session.CommCareSession;
import org.commcare.util.CommCarePlatform;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.core.process.XmlFormRecordProcessor;
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
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.xpath.XPathException;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONObject;
import java.util.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Real case database filters plus separate menu-session worker data, and a case owner read from the session. */
public class WorkerIdentityRuntimeTest {
 private static TreeElement node(String name,String value){TreeElement n=new TreeElement(name,0);if(value!=null)n.setValue(new StringData(value));return n;}
 private static final class Runtime extends CommCareInstanceInitializer {
  final MockUserDataSandbox sandbox;final String slug,menuValue;
  Runtime(String slug,String menuValue,String caseValue)throws Exception{this(slug,menuValue,caseValue,true);}
  Runtime(String slug,String menuValue,String caseValue,boolean hasWorkerRecord)throws Exception{this(MockDataUtils.getStaticStorage(),slug,menuValue,caseValue,hasWorkerRecord);}
  private Runtime(MockUserDataSandbox sandbox,String slug,String menuValue,String caseValue,boolean hasWorkerRecord)throws Exception{
   super(sandbox);this.sandbox=sandbox;this.slug=slug;this.menuValue=menuValue;
   for(String id:new String[]{"correct","other-user","wrong-type"}){
    if(id.equals("correct") && !hasWorkerRecord)continue;
    Case record=new Case(id.equals("correct") ? "Amina Diallo" : id,id.equals("wrong-type")?"patient":"commcare-user");record.setCaseId(id);record.setProperty("username",id.equals("correct")?"amina":"wrong");record.setProperty("hq_user_id",id.equals("other-user")?"other-worker":"worker");record.setProperty(slug,id.equals("correct")?caseValue:"n");sandbox.getCaseStorage().write(record);
   }
  }
  @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance){
   TreeElement root=node("session",null),context=node("context",null),user=node("user",null),data=node("data",null);
   context.addChild(node("userid","worker"));for(String key:new String[]{"deviceid","username","appversion"})context.addChild(node(key,"fixture-"+key));context.addChild(node("drift","0"));data.addChild(node(slug,menuValue));user.addChild(data);root.addChild(context);root.addChild(user);
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 private static final class Parser extends SuiteParser{
  Parser(InputStream input,Runtime runtime)throws IOException{this(input,runtime.sandbox);}
  Parser(InputStream input,MockUserDataSandbox sandbox)throws IOException{super(input,null,"worker-wire",sandbox.getAppFixtureStorage(),true,false,false);}
 }
 @Test public void builtInFormIdentityRequiresTheMatchingWorkerRecord()throws Exception{
  for(boolean present:new boolean[]{true,false}){
   Runtime runtime=new Runtime("is_supervisor","n","n",present);
   org.javarosa.core.model.FormDef form=new FormParseInit("/worker/worker-is_supervisor.xml").getFormDef();
   form.initialize(true,runtime);
   for(String[] expectation:new String[][]{{"current_worker_id","worker"},{"current_worker_login","amina"},{"current_worker_name","Amina Diallo"}}){
    Object value=org.javarosa.test_utils.ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/"+expectation[0]+")");
    assertEquals(expectation[0]+" worker record="+present,present?expectation[1]:"",value);
   }
  }
 }
 @Test public void menuAndFormResolveTheNamedPropertyInTheirNativeContext()throws Exception{
  for(String slug:new String[]{"is_supervisor","district-code","supervision_status"})for(boolean hq:new boolean[]{false,true})for(String menuValue:new String[]{"n","y"})for(String caseValue:new String[]{"n","y"}){
   Runtime runtime=new Runtime(slug,menuValue,caseValue);Suite suite;
   try(InputStream input=getClass().getResourceAsStream("/worker/worker-"+slug+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(input);suite=new Parser(input,runtime).parse();}
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);
   CommCareSession session=new CommCareSession(platform);
   EvaluationContext menuContext=session.getEvaluationContext(runtime,"m0",null);
   assertEquals(menuValue.equals("n"),FunctionUtils.toBoolean(suite.getMenus().firstElement().getMenuRelevance().eval(menuContext)));
   FormParseInit parsed=new FormParseInit("/worker/worker-"+slug+(hq?".hq.xml":".xml"));parsed.getFormDef().initialize(true,runtime);
   FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());int count=0,steps=0;
   while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM){if(++steps>20)throw new AssertionError("Unexpected traversal");if(parsed.getFormEntryModel().getEvent()==FormEntryController.EVENT_QUESTION)count++;}
   assertEquals(slug+" menu="+menuValue+" case="+caseValue,caseValue.equals("n")?1:0,count);
  }
 }
 /** A worker's session holding exactly {@code user} as its user data, choosing the case {@code patient-1}. */
 private static final class PlaceRuntime extends CommCareInstanceInitializer {
  final MockUserDataSandbox sandbox;final Map<String,String> user;
  PlaceRuntime(Map<String,String> user){this(MockDataUtils.getStaticStorage(),user);}
  private PlaceRuntime(MockUserDataSandbox sandbox,Map<String,String> user){super(sandbox);this.sandbox=sandbox;this.user=user;}
  @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance){
   TreeElement root=node("session",null),context=node("context",null),userNode=node("user",null),userData=node("data",null),data=node("data",null);
   context.addChild(node("userid","worker"));for(String key:new String[]{"deviceid","username","appversion"})context.addChild(node(key,"fixture-"+key));context.addChild(node("drift","0"));
   for(Map.Entry<String,String> field:user.entrySet())userData.addChild(node(field.getKey(),field.getValue()));
   data.addChild(node("case_id","patient-1"));data.addChild(node("case_id_new_patient_0","shared-patient"));userNode.addChild(userData);root.addChild(context);root.addChild(userNode);root.addChild(data);
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 /**
  * A case owner read from a field the worker's session lacks ({@code worker-place-owner}: a follow-up whose case
  * change moves the patient to the worker's case-sharing group, {@code external-user('commcare_primary_case_sharing_id')},
  * which HQ writes only for a worker assigned somewhere). A case block's owner is a calculate Core runs as the form
  * opens ({@code FormDef.initialize}), so a worker assigned nowhere is refused there, naming the field, and a placed
  * worker fills the form in and the patient's owner becomes the worker's group, on Nova's form and HQ's regeneration;
  * Preview refuses the form at open exactly for the first ({@code worker-place-owner.refusals.jsonl}, from its form
  * engine's opening, {@code dataRefusal.ts::caseBlocksReadAbsentWorkerKey}). Each reading parses the form again, since
  * Core checks a parsed path only until the check first passes ({@code XPathPathExpr.templatePathChecked}).
  */
 @Test public void aCaseOwnerReadFromAFieldTheWorkerLacksRefusesTheFormAtOpenWhereNovaSays()throws Exception{
  List<JSONObject> readings=new ArrayList<>();
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/worker/worker-place-owner.refusals.jsonl"),StandardCharsets.UTF_8))){String line;while((line=reader.readLine())!=null)if(!line.isEmpty())readings.add(new JSONObject(line));}
  int refused=0,opened=0;
  for(JSONObject reading:readings)for(boolean hq:new boolean[]{false,true}){
   Map<String,String> user=new LinkedHashMap<>();JSONObject fields=reading.getJSONObject("user");for(String key:fields.keySet())user.put(key,fields.getString(key));
   String label="user="+user+" hq="+hq;
   PlaceRuntime runtime=new PlaceRuntime(user);
   Case patient=new Case("Patient","patient");patient.setCaseId("patient-1");patient.setUserId("worker");runtime.sandbox.getCaseStorage().write(patient);
   FormParseInit parsed=new FormParseInit("/worker/worker-place-owner"+(hq?".hq.xml":".xml"));
   XPathException failure=null;
   try{parsed.getFormDef().initialize(true,runtime);}catch(XPathException e){failure=e;}
   assertEquals(label,reading.getBoolean("refused"),failure!=null);
   if(failure!=null){assertTrue(label+": "+failure.getMessage(),failure.getMessage().contains("commcare_primary_case_sharing_id"));refused++;continue;}
   FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());int steps=0;
   while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM){if(++steps>20)throw new AssertionError("Form did not terminate");}
   parsed.getFormDef().postProcessInstance();byte[] xml=new XFormSerializingVisitor().serializeInstance(parsed.getFormDef().getMainInstance());
   XmlFormRecordProcessor.process(runtime.sandbox,new ByteArrayInputStream(xml));
   assertEquals(label,user.get("commcare_primary_case_sharing_id"),runtime.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID,"patient-1").getUserId());
   opened++;
  }
  // The worker assigned nowhere is refused on both forms, and the placed worker's group owns the patient on both.
  assertEquals(2,refused);assertEquals(2,opened);
 }

    @Test public void hqRestoredGroupsAdmitOneOwnerAndCoreSubmitsTheCaseToThatGroup() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            for (String name : new String[]{"ada", "bea", "cal"}) {
                String label = name + (hq ? " via HQ" : " local");
                MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
                sandbox.setLoggedInUser(new org.javarosa.core.model.User(name, "synthetic", "mobile-" + name));
                try (InputStream restore = getClass().getResourceAsStream("/worker/worker-groups-" + name + ".restore.xml")) {
                    assertNotNull(label, restore);
                    org.commcare.core.parse.ParseUtils.parseIntoSandbox(restore, sandbox);
                }
                PlaceRuntime runtime = new PlaceRuntime(sandbox, Collections.emptyMap());
                Suite suite;
                try (InputStream input = getClass().getResourceAsStream("/worker/worker-shared-case" + (hq ? ".hq-suite.xml" : ".suite.xml"))) {
                    assertNotNull(label, input);
                    suite = new Parser(input, sandbox).parse();
                }
                org.commcare.suite.model.Entry entry = suite.getEntry("m0-f0");
                Hashtable<String, DataInstance> instances = entry.getInstances(null);
                for (String id : new ArrayList<>(instances.keySet())) {
                    instances.put(id, instances.get(id).initialize(runtime, id));
                }
                EvaluationContext context = new EvaluationContext(null, instances);
                assertEquals(label, !name.equals("bea"), entry.getAssertions().getAssertionFailure(context) != null);
                if (!name.equals("bea")) {
                    assertEquals(label, 0, sandbox.getCaseStorage().getNumRecords());
                    continue;
                }
                // HQ serves the detail as " Friday " (the HQ step holds it); Core reads every fixture text trimmed
                // (TreeElementParser.parse), as Preview's groups instance does.
                assertEquals(label, "Friday", org.javarosa.test_utils.ExprEvalUtils.xpathEval(context,
                    "string(instance('groups')/groups/group/group_data/data[@key='meeting'])"));
                FormParseInit parsed = new FormParseInit("/worker/worker-shared-case" + (hq ? ".hq.xml" : ".xml"));
                parsed.getFormDef().initialize(true, runtime);
                FormEntryController controller = parsed.getFormEntryController();
                controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
                int steps = 0;
                while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
                    if (++steps > 20) throw new AssertionError("Shared registration did not finish");
                    if (parsed.getFormEntryModel().getEvent() == FormEntryController.EVENT_QUESTION) {
                        controller.answerQuestion(new StringData("Shared patient"));
                    }
                }
                parsed.getFormDef().postProcessInstance();
                byte[] submission = new XFormSerializingVisitor().serializeInstance(parsed.getFormDef().getMainInstance());
                XmlFormRecordProcessor.process(sandbox, new ByteArrayInputStream(submission));
                assertEquals(label, "east", sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "shared-patient").getUserId());
            }
        }
    }
}
