"""Native HQ media import, bulk matching, attachment decoding, suite and form generation."""
import argparse
from contextlib import ExitStack
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import zipfile
from unittest.mock import patch
from types import SimpleNamespace
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--hq-root',type=Path,required=True)
parser.add_argument('--exports',type=Path,required=True)
parser.add_argument('--python-path',type=Path)
parser.add_argument('--prepare-validation',action='store_true')
args=parser.parse_args(); hq_root=args.hq_root.resolve(); output=args.exports.resolve()
sys.path.insert(0,str(hq_root))
if args.python_path: sys.path.append(str(args.python_path.resolve()))
def deny_network(*_args,**_kwargs): raise RuntimeError('Network disabled for native HQ media proof')
socket.socket.connect=deny_network;socket.socket.connect_ex=deny_network
os.environ['CCHQ_TESTING']='1';os.environ['DJANGO_SETTINGS_MODULE']='testsettings'
from manage import init_hq_python_path
init_hq_python_path()
import django
django.setup()
from django.conf import settings
from django.test import override_settings
from lxml import etree
from corehq.apps.app_manager.models import Application
from corehq.apps.app_manager.xform import XForm
from corehq.apps.builds.models import BuildSpec
from corehq.apps.app_manager.suite_xml.generator import SuiteGenerator, MediaSuiteGenerator
from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
from corehq.apps.app_manager.suite_xml.sections.entries import EntriesContributor
from corehq.apps.app_manager.suite_xml.sections.menus import MenuContributor
from corehq.apps.app_manager.suite_xml.post_process.instances import InstancesHelper
from corehq.apps.app_manager.suite_xml.post_process.workflow import WorkflowHelper
from corehq.apps.hqmedia.models import CommCareMultimedia
from corehq.apps.hqmedia.cache import BulkMultimediaStatusCache, BulkMultimediaStatusCacheNfs
from corehq.apps.hqmedia.tasks import process_bulk_upload_zip
override_settings(CACHES={name:{'BACKEND':'django.core.cache.backends.locmem.LocMemCache','LOCATION':f'nova-media-{name}'} for name in settings.CACHES}).enable()
if args.prepare_validation:
    for name in ['media-rich-on','media-rich-off','media-only-on','media-only-off']:
        form=XForm((output/f'{name}.source.xml').read_bytes())
        form.strip_vellum_ns_attributes()
        (output/f'{name}.validation.xml').write_bytes(etree.tostring(form.xml))
    print(json.dumps({'prepared':4,'transform':'actual HQ XForm.strip_vellum_ns_attributes'}))
    sys.exit(0)
# The external Formplayer adapter is backed by a prior native Core parse of
# these exact bytes. It refuses every other document rather than returning a
# blanket mocked validation answer. Core certificate is generated first.
certificate=dict(line.strip().split('=',1) for line in (output/'core-validated-sources.properties').read_text().splitlines() if line and not line.startswith('#'))
validated={}
for name,digest in certificate.items():
    raw=(output/name).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==digest
    validated[etree.tostring(etree.fromstring(raw),method='c14n')]=name
assert len(validated)==4
validated_calls=[]
def validated_formplayer_response(source):
    canonical=etree.tostring(etree.fromstring(source),method='c14n')
    assert canonical in validated, 'HQ requested validation for a source not proven by native Core'
    validated_calls.append(validated[canonical])
    return SimpleNamespace(success=True)
results=[]
for name in ['media-rich-on','media-rich-off','media-only-on','media-only-off']:
    enabled=name.endswith('-on')
    with patch('corehq.apps.app_manager.models.applications.get_default_build_spec',return_value=BuildSpec(version='2.53.0',build_number=1)):
        app=Application.from_source(json.loads((output/f'{name}.json').read_bytes()),'nova-media-proof')
    app._id=name;app.version=1;app.custom_base_url='https://www.commcarehq.org'
    with ExitStack() as scope:
        scope.enter_context(patch('corehq.apps.app_manager.xform.formplayer_api.validate_form',side_effect=validated_formplayer_response))
        for flag in ['MOBILE_UCR','CASE_LIST_OPTIMIZATIONS','USH_EMPTY_CASE_LIST_TEXT','DATA_REGISTRY','CASE_SEARCH_ENDPOINTS','MOBILE_RECOVERY_MEASURES','CUSTOM_PROPERTIES']:
            scope.enter_context(patch('corehq.toggles.'+flag+'.enabled',return_value=False))
        scope.enter_context(patch('corehq.apps.app_manager.models.applications.domain_has_usercase_access',return_value=False))
        scope.enter_context(patch('corehq.apps.app_manager.models.applications.domain_has_privilege',return_value=True))
        scope.enter_context(patch('corehq.apps.app_manager.app_strings.domain_has_privilege',return_value=False))
        scope.enter_context(patch('corehq.apps.app_manager.suite_xml.sections.entries.case_search_sync_cases_on_form_entry_enabled_for_domain',return_value=False))
        scope.enter_context(patch('corehq.util.view_utils.get_url_base',return_value='https://www.commcarehq.org'))
        form=app.get_module(0).get_form(0)
        with patch('corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled',return_value=False),patch('corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled',return_value=False):
            compiled=XForm(form.source,domain=app.domain);compiled.add_case_and_meta(form);compiled.strip_vellum_ns_attributes()
        (output/f'{name}.hq.xml').write_bytes(etree.tostring(compiled.xml))
        generator=SuiteGenerator(app);generator.add_section(DetailContributor)
        entries=EntriesContributor(generator.suite,app,generator.modules,None);menus=MenuContributor(generator.suite,app,generator.modules,None)
        for module in generator.modules:
            generator.suite.entries.extend(entries.get_module_contributions(module));generator.suite.menus.extend(menus.get_module_contributions(module,None))
        WorkflowHelper(generator.suite,app,generator.modules).update_suite();InstancesHelper(generator.suite,app,generator.modules).update_suite()
        (output/f'{name}.hq.suite.xml').write_bytes(generator.suite.serializeDocument(pretty=True))
        (output/f'{name}.hq.strings.properties').write_text(app.create_app_strings('en'))
        (output/f'{name}.hq.profile.xml').write_bytes(app.create_profile(with_media=enabled))
        native_media=etree.fromstring(MediaSuiteGenerator(app).generate_suite())
        (output/f'{name}.hq.media-suite.xml').write_bytes(etree.tostring(native_media))
        local_media=etree.fromstring((output/f'{name}.media-suite.xml').read_bytes())
        # IDs/descriptors and remote HQ locations legitimately differ. The
        # local locations, emitted path metadata and version must agree.
        # Core InstallerFactory ignores the media path when choosing its installer.
        resource_shape=lambda root: sorted((media.get('path'),resource.get('version'),location.text) for media in root.findall('media') for resource in media.findall('resource') for location in resource.findall('location') if location.get('authority')=='local')
        assert resource_shape(local_media)==resource_shape(native_media),(name,resource_shape(local_media),resource_shape(native_media))
        if not enabled:
            assert len(local_media)==0 and app.multimedia_map=={}
            results.append({'scenario':name,'mediaResources':0});continue
        archive=zipfile.ZipFile(output/f'{name}.multimedia.zip'); expected={p:archive.read(p) for p in archive.namelist()};archive.close()
        assert len(expected)==5
        stored={};objects={}
        # Substitute only external document/blob persistence. Native MIME
        # sniffing, image decoding, hash lookup, ownership, matching, mapping,
        # status folding and the full bulk-upload task remain actual HQ code.
        def memory_by_hash(cls,file_hash):
            return objects.setdefault((cls.__name__,file_hash),cls(_id=f'{cls.__name__}-{file_hash}',file_hash=file_hash))
        def put_attachment(media,data,*_args,**_kwargs): stored[media._id]=bytes(data)
        with patch.object(CommCareMultimedia,'get_by_hash',classmethod(memory_by_hash)),patch.object(CommCareMultimedia,'save',lambda *_a,**_k:None),patch.object(CommCareMultimedia,'put_attachment',put_attachment),patch.object(CommCareMultimedia,'content_length',property(lambda media:len(stored[media._id]))),patch.object(Application,'save',lambda *_a,**_k:None),patch('corehq.apps.hqmedia.tasks.get_app',return_value=app):
            status=BulkMultimediaStatusCacheNfs(name,str(output/f'{name}.multimedia.zip'));status.save()
            process_bulk_upload_zip.run(name,app.domain,app._id,username='proof')
            result=BulkMultimediaStatusCache.get(name).get_response()
        assert result['complete'] and result['progress']['percent']==100,result
        assert result['errors']==[] and result['unmatched_count']==0 and result['skipped_files']==[],result
        assert (result['image_count'],result['audio_count'],result['video_count'])==(3,1,1),result
        assert {info['original_path'] for group in result['matched_files'].values() for info in group}==set(expected)
        for path,raw in expected.items():
            media_class=CommCareMultimedia.get_class_by_data(raw,filename=path)
            reference=media_class.get_form_path(path)
            mapping=app.multimedia_map[reference]
            assert mapping.media_type==media_class.__name__
            assert stored[mapping.multimedia_id]==raw
            assert objects[(media_class.__name__,media_class.generate_hash(raw))].owners==[app.domain]
        results.append({'scenario':name,'mediaResources':len(expected),'bulkStatus':result})
paths=['corehq/apps/hqmedia/tasks.py','corehq/apps/hqmedia/models.py','corehq/apps/hqmedia/cache.py','corehq/apps/app_manager/suite_xml/generator.py','corehq/apps/app_manager/xform.py']
print(json.dumps({'hqCommit':subprocess.check_output(['git','-C',str(hq_root),'rev-parse','HEAD'],text=True).strip(),'hqSourceHashes':{p:hashlib.sha256((hq_root/p).read_bytes()).hexdigest() for p in paths},'novaSourceHashes':json.loads((output/'media-source-hashes.json').read_bytes()),'results':results,'nativeValidatedSources':certificate,'validationCalls':validated_calls,'limits':'Native import, form/detail/menu/profile/media-suite generation and full bulk-multimedia task. External Formplayer validation accepts only exact sources already parsed by Core. Couch/blob persistence replaced in memory; native classification, PNG decode, attachment metadata, matching, ownership and mapping retained. No database persistence, network, rendered client or media playback.'},indent=2))
