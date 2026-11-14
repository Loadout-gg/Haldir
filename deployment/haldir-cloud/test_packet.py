#!/usr/bin/env python3
"""Local synthetic unit tests of packaging; never application or cloud evidence."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('packet', HERE / 'packet.py')
assert spec is not None and spec.loader is not None
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PacketTests(unittest.TestCase):
    def setUp(self):
        # Replace, rather than read or inherit, the operator environment.
        environment = patch.object(os, 'environ', {})
        environment.start()
        self.addCleanup(environment.stop)
        # All fixture data stays inside this lane and is explicitly synthetic.
        self.tmp = Path(tempfile.mkdtemp(prefix='.packaging-test-', dir=HERE))
        self.root = self.tmp / 'synthetic-root'
        self.root.mkdir()
        package = {'type': 'module', 'engines': {'node': '26.13.1'}, 'dependencies': p.DEPS}
        lock = {'lockfileVersion': 3, 'packages': {'': {'dependencies': p.DEPS}}}
        self.release = {'projectId': p.PROJECT, 'projectNumber': p.NUMBER, 'databaseId': 'haldir',
                        'financialActions': False, 'approvedOrigin': 'https://synthetic-unit-test.invalid',
                        'approvalReference': 'SYNTHETIC_UNIT_TEST_ONLY', 'sources': {}, 'ui': {}}
        for name in p.RUNTIME:
            data = json.dumps(package if name.endswith('/package.json') else lock).encode() if name.endswith('.json') else b'// synthetic packaging unit test, not application code\n'
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            self.release['sources'][name] = p.digest(data)
        for name in ['index.html', 'assets/ui.js', 'fonts/Manrope[wght].ttf']:
            target = self.root / 'deployment/haldir-preview/ui' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'synthetic-unit-test-only')
            self.release['ui'][name] = p.digest(target.read_bytes())

        self.ui_receipt_path = 'deployment/haldir-preview/ui-build-receipt.json'
        self.ui_receipt = {'approvedOrigin': self.release['approvedOrigin'],
                           'viteApprovedOrigin': self.release['approvedOrigin'],
                           'outputs': self.release['ui']}
        self.write_ui_receipt()

    def write_ui_receipt(self):
        data = json.dumps(self.ui_receipt).encode()
        (self.root / self.ui_receipt_path).write_bytes(data)
        self.release['uiBuildReceiptSha256'] = p.digest(data)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_startup_receipt_packaged_and_origin_bound(self):
        receipt = p.assemble(self.root, self.release, self.tmp / 'good')
        self.assertIn(self.ui_receipt_path, receipt['files'])
        self.assertEqual(receipt['files'][self.ui_receipt_path], self.release['uiBuildReceiptSha256'])
        dockerfile = (self.tmp / 'good/Dockerfile').read_text()
        self.assertIn('COPY deployment/haldir-preview/ui-build-receipt.json ./deployment/haldir-preview/', dockerfile)
        for field in ['approvedOrigin', 'viteApprovedOrigin', 'outputs']:
            previous = self.ui_receipt[field]
            self.ui_receipt[field] = {} if field == 'outputs' else 'https://other.invalid'
            self.write_ui_receipt()
            with self.assertRaisesRegex(ValueError, 'UI_BUILD_RECEIPT_BINDING_MISMATCH'):
                p.assemble(self.root, self.release, self.tmp / ('bad-' + field))
            self.ui_receipt[field] = previous
        self.write_ui_receipt()
        self.release['uiBuildReceiptSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'UI_BUILD_RECEIPT_HASH_MISMATCH'):
            p.assemble(self.root, self.release, self.tmp / 'bad-hash')

    def test_exact_membership_and_manifest_relocation(self):
        stage = self.tmp / 'stage'
        receipt = p.assemble(self.root, self.release, stage)
        self.assertEqual(set(receipt['files']), (set(p.RUNTIME) - {
            'deployment/haldir-preview/package.json', 'deployment/haldir-preview/package-lock.json'}) |
            {'package.json', 'package-lock.json', 'Dockerfile', 'cloudbuild.json', '.dockerignore', '.gcloudignore',
             self.ui_receipt_path} |
            {'deployment/haldir-preview/ui/' + name for name in self.release['ui']})
        self.assertEqual((stage / 'package.json').read_bytes(),
                         (self.root / 'deployment/haldir-preview/package.json').read_bytes())
        self.assertTrue((stage / '.dockerignore').read_text().startswith('**\n'))
        self.assertNotIn('.hermes', '\n'.join(receipt['files']))

    def test_build_config_is_frozen_in_stage_and_command(self):
        os.environ['HALDIR_GCLOUD_ACCOUNT'] = 'operator@example.invalid'
        stage = self.tmp / 'stage' / 'candidate'
        receipt = p.assemble(self.root, self.release, stage)
        self.assertIn('cloudbuild.json', receipt['files'])
        self.assertEqual((stage / 'cloudbuild.json').read_bytes(), (HERE / 'cloudbuild.json').read_bytes())
        original = p.HERE
        try:
            setattr(p, 'HERE', self.tmp)
            command = p.build_commands(stage)['submitOneBuild']
            self.assertIn('--config=' + str(stage / 'cloudbuild.json'), command)
            (stage / 'cloudbuild.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'STAGE_MEMBERSHIP_OR_HASH_CHANGED'):
                p.build_commands(stage)
        finally:
            setattr(p, 'HERE', original)

    def test_literal_bracket_font_is_not_a_glob_in_ignores(self):
        stage = self.tmp / 'literal-font'
        p.assemble(self.root, self.release, stage)
        self.assertIn(r'!/deployment/haldir-preview/ui/fonts/Manrope\[wght\].ttf',
                      (stage / '.dockerignore').read_text().splitlines())
        # The installed gcloud matcher unescapes before Python fnmatch, unlike Docker.
        self.assertIn('!/deployment/haldir-preview/ui/fonts/Manrope[[]wght[]].ttf',
                      (stage / '.gcloudignore').read_text().splitlines())

    def test_missing_or_extra_runtime_rejected_without_stage(self):
        for name in ['missing', 'extra']:
            release = copy.deepcopy(self.release)
            if name == 'missing':
                release['sources'].pop(p.RUNTIME[0])
            else:
                release['sources']['.hermes/private.json'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'EXACT_RUNTIME_SOURCE_SET_REQUIRED'):
                p.assemble(self.root, release, self.tmp / name)
            self.assertFalse((self.tmp / name).exists())

    def test_changed_source_rejected(self):
        (self.root / p.RUNTIME[0]).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'SOURCE_HASH_MISMATCH'):
            p.assemble(self.root, self.release, self.tmp / 'bad')

    def test_symlink_rejected(self):
        target = self.root / p.RUNTIME[0]
        target.unlink()
        target.symlink_to(self.root / p.RUNTIME[1])
        with self.assertRaisesRegex(ValueError, 'SYMLINK_FORBIDDEN'):
            p.assemble(self.root, self.release, self.tmp / 'bad')

    def test_ui_private_secret_traversal_rejected(self):
        for member in ['.env', 'assets/../../private.js', '../private.js', 'assets/client.map']:
            release = copy.deepcopy(self.release)
            release['ui'][member] = '0' * 64
            with self.assertRaises(ValueError):
                p.assemble(self.root, release, self.tmp / 'bad')

    def test_malformed_lock_rejected(self):
        name = 'deployment/haldir-preview/package-lock.json'
        lock = json.loads((self.root / name).read_bytes())
        lock['packages']['node_modules/evil'] = {'resolved': 'file:../../secret', 'integrity': 'sha512-AA=='}
        data = json.dumps(lock).encode()
        (self.root / name).write_bytes(data)
        self.release['sources'][name] = p.digest(data)
        with self.assertRaisesRegex(ValueError, 'LOCK_NONREGISTRY_OR_UNVERIFIED_ENTRY'):
            p.assemble(self.root, self.release, self.tmp / 'bad')

    def test_financial_or_wrong_project_blocked(self):
        for key, val in [('financialActions', True), ('projectId', 'loadout-haldir-demo147018706305'), ('databaseId', '(default)')]:
            release = copy.deepcopy(self.release); release[key] = val
            with self.assertRaises(ValueError):
                p.assemble(self.root, release, self.tmp / 'bad')

    def test_no_fabricated_deployment_digest_or_origin(self):
        os.environ['HALDIR_GCLOUD_ACCOUNT'] = 'operator@example.invalid'
        for origin, image in [('', p.IMAGE + '@sha256:' + '0' * 64),
                              ('https://preview.example', p.IMAGE + ':latest')]:
            with self.assertRaises(ValueError):
                p.deploy_commands(origin, image, 'release-01')
        # Synthetic renderer input, NOT a provider-returned URL or application digest.
        rendered = p.deploy_commands('https://synthetic-unit-test.invalid', p.IMAGE + '@sha256:' + '0' * 64, 'release-01')
        command = rendered['oneDeployment']
        self.assertIn('--max=1', command)
        self.assertIn('--min=0', command)
        self.assertIn('--concurrency=4', command)
        self.assertIn('--timeout=30s', command)
        self.assertIn('--no-invoker-iam-check', command)
        self.assertNotIn('--allow-unauthenticated', command)

    def test_no_billing_project_creation_or_org_policy_mutations(self):
        os.environ['HALDIR_GCLOUD_ACCOUNT'] = 'operator@example.invalid'
        rendered = json.dumps(p.foundation())
        for forbidden in ['billing', 'projects", "create', 'org-policies", "set-policy',
                          'roles/owner', 'roles/editor', 'cloudscheduler.googleapis.com', 'secretmanager.googleapis.com']:
            self.assertNotIn(forbidden, rendered if forbidden != 'billing' else json.dumps(p.foundation()['createOnlyIfExactResourceAbsent']))
        self.assertEqual(len(p.foundation()['createOnlyIfExactResourceAbsent']), 5)

    def test_account_missing_rejects_command_rendering(self):
        for environment in [{}, {'HALDIR_GCLOUD_ACCOUNT': ''}]:
            with self.subTest(environment=environment), patch.object(os, 'environ', environment):
                with self.assertRaisesRegex(ValueError, '^EXPLICIT_HALDIR_GCLOUD_ACCOUNT_REQUIRED$'):
                    p.gc('services', 'list')

    def test_invalid_account_and_injection_rejected(self):
        invalid = [
            ' ', 'operator', '@example.invalid', 'operator@',
            '.operator@example.invalid', 'operator.@example.invalid',
            'operator..name@example.invalid', 'operator@@example.invalid',
            'operator@-example.invalid', 'operator@example-.invalid',
            'operator@example..invalid', 'operator@example.invalid.',
            'operator@localhost', 'operator@[127.0.0.1]',
            'operator@' + 'x' * 64 + '.invalid',
            'x' * 65 + '@example.invalid',
            'x' * 64 + '@' + '.'.join(['x' * 63] * 3) + '.invalid',
            '--account=operator@example.invalid', '-operator@example.invalid',
            'operator@example.invalid --project=other',
            'operator@example.invalid,other@example.invalid',
            'operator@example.invalid;echo injected',
            'operator@example.invalid&&echo injected',
            'operator@example.invalid|echo injected',
            'operator@example.invalid$(echo injected)',
            'operator@example.invalid`echo injected`',
            '"operator"@example.invalid', 'operator\\name@example.invalid',
            'operator\u200b@example.invalid', 'operator\u00a0@example.invalid',
        ]
        invalid += ['operator' + chr(code) + '@example.invalid' for code in list(range(33)) + [127]]
        for value in invalid:
            with self.subTest(value=repr(value)), patch.object(os, 'environ', {'HALDIR_GCLOUD_ACCOUNT': value}):
                with self.assertRaisesRegex(ValueError, '^VALID_HALDIR_GCLOUD_ACCOUNT_EMAIL_REQUIRED$'):
                    p.gc('services', 'list')

    def test_explicit_account_used_by_every_renderer_and_operator_binding(self):
        os.environ['HALDIR_GCLOUD_ACCOUNT'] = 'operator@example.invalid'
        expected = '--account=operator@example.invalid'
        self.assertEqual(p.gc('services', 'list'),
                         ['gcloud', 'services', 'list', expected, '--project=' + p.PROJECT, '--quiet'])
        stage = self.tmp / 'stage' / 'candidate'
        p.assemble(self.root, self.release, stage)
        foundation = p.foundation()
        with patch.object(p, 'HERE', self.tmp):
            rendered = [p.readbacks(), foundation, p.build_commands(stage),
                        p.deploy_commands(self.release['approvedOrigin'], p.IMAGE + '@sha256:' + '0' * 64, 'release-01')]

        def commands(value):
            if isinstance(value, dict):
                for child in value.values():
                    yield from commands(child)
            elif isinstance(value, list):
                if value and value[0] == 'gcloud':
                    yield value
                else:
                    for child in value:
                        yield from commands(child)

        all_commands = list(commands(rendered))
        self.assertTrue(all_commands)
        for command in all_commands:
            self.assertEqual([arg for arg in command if arg.startswith('--account=')], [expected])
            self.assertIn('--project=' + p.PROJECT, command)
        user_members = [arg for command in commands(foundation) for arg in command if arg.startswith('--member=user:')]
        self.assertEqual(user_members, ['--member=user:operator@example.invalid'] * 2)
        # Configuration is read lazily rather than cached from import or an earlier call.
        os.environ.clear()
        with self.assertRaisesRegex(ValueError, '^EXPLICIT_HALDIR_GCLOUD_ACCOUNT_REQUIRED$'):
            p.gc('services', 'list')

    def test_import_and_assembly_do_not_read_account_configuration(self):
        class UnreadableEnvironment(dict):
            def get(self, *args, **kwargs):
                raise AssertionError('ASSEMBLY_MUST_NOT_READ_OPERATOR_CONFIGURATION')

        with patch.object(os, 'environ', UnreadableEnvironment()):
            fresh_spec = importlib.util.spec_from_file_location('packet_without_account', HERE / 'packet.py')
            assert fresh_spec is not None and fresh_spec.loader is not None
            fresh = importlib.util.module_from_spec(fresh_spec)
            fresh_spec.loader.exec_module(fresh)
            receipt = fresh.assemble(self.root, self.release, self.tmp / 'without-account')
        self.assertEqual(receipt['status'], 'ASSEMBLED_ONLY_NOT_BUILT_OR_DEPLOYED')

    def test_bad_account_blocks_every_rendering_entrypoint_before_output_or_writes(self):
        stage = self.tmp / 'stage' / 'candidate'
        p.assemble(self.root, self.release, stage)
        built = self.tmp / 'synthetic-build-receipt.json'
        image = p.IMAGE + '@sha256:' + '0' * 64
        built.write_text(json.dumps({'projectId': p.PROJECT, 'status': 'SUCCESS',
                                    'serviceAccount': 'projects/' + p.PROJECT + '/serviceAccounts/' + p.BUILD_SA,
                                    'results': {'images': [{'name': p.IMAGE + ':synthetic', 'digest': 'sha256:' + '0' * 64}]}}))
        def snapshot():
            return {str(path.relative_to(self.tmp)): p.digest(path.read_bytes()) if path.is_file() else None
                    for path in self.tmp.rglob('*')}

        before = snapshot()
        actions = [lambda: p.gc('services', 'list'), p.readbacks, p.foundation,
                   lambda: p.build_commands(stage),
                   lambda: p.deploy_commands(self.release['approvedOrigin'], image, 'release-01')]
        cli_arguments = [['foundation'], ['inspect-build', '--id', '00000000-0000-0000-0000-000000000000'],
                         ['build', '--stage', str(stage)],
                         ['deploy', '--stage', str(stage), '--build-receipt', str(built),
                          '--origin', self.release['approvedOrigin'], '--image', image, '--revision', 'release-01']]
        for environment in [{}, {'HALDIR_GCLOUD_ACCOUNT': ''}, {'HALDIR_GCLOUD_ACCOUNT': ' '},
                            {'HALDIR_GCLOUD_ACCOUNT': 'operator@example.invalid;echo injected'}]:
            error = 'EXPLICIT_HALDIR_GCLOUD_ACCOUNT_REQUIRED' if not environment.get('HALDIR_GCLOUD_ACCOUNT') else 'VALID_HALDIR_GCLOUD_ACCOUNT_EMAIL_REQUIRED'
            with patch.object(os, 'environ', environment), patch.object(p, 'HERE', self.tmp):
                for index, action in enumerate(actions):
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with self.subTest(environment=environment, renderer=index), redirect_stdout(stdout), redirect_stderr(stderr):
                        with self.assertRaisesRegex(ValueError, '^' + error + '$'):
                            action()
                    self.assertEqual(stdout.getvalue(), '')
                    self.assertEqual(stderr.getvalue(), '')
                    self.assertEqual(snapshot(), before)
                for arguments in cli_arguments:
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with self.subTest(environment=environment, arguments=arguments), patch.object(sys, 'argv', ['packet.py', *arguments]), redirect_stdout(stdout), redirect_stderr(stderr):
                        with self.assertRaisesRegex(ValueError, '^' + error + '$'):
                            p.main()
                    self.assertEqual(stdout.getvalue(), '')
                    self.assertEqual(stderr.getvalue(), '')
                    self.assertEqual(snapshot(), before)

    def test_cli_account_errors_are_fail_closed_and_valid_account_renders_json(self):
        script = str(HERE / 'packet.py')
        for environment, error in [({}, 'EXPLICIT_HALDIR_GCLOUD_ACCOUNT_REQUIRED'),
                                   ({'HALDIR_GCLOUD_ACCOUNT': 'operator@example.invalid;echo injected'},
                                    'VALID_HALDIR_GCLOUD_ACCOUNT_EMAIL_REQUIRED')]:
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(os, 'environ', environment), patch.object(sys, 'argv', [script, 'foundation']), redirect_stdout(stdout), redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as exit_result:
                    runpy.run_path(script, run_name='__main__')
            self.assertEqual(exit_result.exception.code, 2)
            self.assertEqual(stdout.getvalue(), '')
            self.assertEqual(stderr.getvalue(), error + '\n')
        stdout, stderr = io.StringIO(), io.StringIO()
        os.environ['HALDIR_GCLOUD_ACCOUNT'] = 'operator@example.invalid'
        with patch.object(sys, 'argv', [script, 'inspect-build', '--id', '00000000-0000-0000-0000-000000000000']), redirect_stdout(stdout), redirect_stderr(stderr):
            runpy.run_path(script, run_name='__main__')
        rendered = json.loads(stdout.getvalue())
        self.assertEqual(set(rendered), {'buildReadback', 'registryReadback'})
        for command in rendered.values():
            self.assertIn('--account=operator@example.invalid', command)
        self.assertEqual(stderr.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
