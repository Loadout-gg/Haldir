#!/usr/bin/env python3
"""Offline-only, finite-context assembler and command renderer. Never runs gcloud."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PROJECT = 'loadout-haldir-demo'
NUMBER = '147018706305'
REGION = 'europe-west1'
SERVICE = 'haldir-auth-preview'
BUILD_SA = f'haldir-build@{PROJECT}.iam.gserviceaccount.com'
RUNTIME_SA = f'haldir-runtime@{PROJECT}.iam.gserviceaccount.com'
BUCKET = f'gs://{PROJECT}-{NUMBER}-build-source'
IMAGE = f'{REGION}-docker.pkg.dev/{PROJECT}/haldir-preview/auth-preview'
RUNTIME = [
    'deployment/haldir-preview/main.mjs',
    'deployment/haldir-preview/server.mjs',
    'deployment/haldir-preview/firestore-repository.mjs',
    'src/server/wallet-auth-http.mjs',
    'src/server/wallet-session.mjs',
    'src/server/near-owner-keys.mjs',
    'deployment/haldir-preview/package.json',
    'deployment/haldir-preview/package-lock.json',
]
POLICIES = ['gcp.resourceLocations', 'iam.allowedPolicyMemberDomains',
            'iam.managed.allowedPolicyMembers', 'run.managed.requireInvokerIam',
            'run.allowedIngress', 'compute.skipDefaultNetworkCreation',
            'iam.automaticIamGrantsForDefaultServiceAccounts',
            'iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']
APIS = ['cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
        'run.googleapis.com', 'firestore.googleapis.com', 'iam.googleapis.com',
        'logging.googleapis.com', 'storage.googleapis.com']
DEPS = {'near-api-js': '7.4.0', '@google-cloud/firestore': '9.4.1'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_read(root, relative):
    p = PurePosixPath(relative)
    require(not p.is_absolute() and '..' not in p.parts and str(p) == relative, 'UNSAFE_PATH')
    current = root
    for part in p.parts:
        current = current / part
        require(not current.is_symlink(), 'SYMLINK_FORBIDDEN')
    require(current.is_file(), 'REQUIRED_FILE_MISSING:' + relative)
    return current.read_bytes()


def approved_origin(origin):
    u = urlsplit(origin)
    require(u.scheme == 'https' and u.netloc and not u.username and not u.password
            and not u.path and not u.query and not u.fragment and ',' not in origin,
            'EXACT_APPROVED_HTTPS_ORIGIN_REQUIRED')
    return origin


def validate_release(root, release):
    approved_origin(release.get('approvedOrigin', ''))
    require(release.get('projectId') == PROJECT and release.get('projectNumber') == NUMBER,
            'PROJECT_ID_NUMBER_MISMATCH')
    require(release.get('databaseId') == 'haldir', 'DATABASE_MUST_BE_HALDIR')
    require(release.get('financialActions') is False, 'FINANCIAL_ACTIONS_FORBIDDEN')
    require(isinstance(release.get('approvalReference'), str) and release['approvalReference'].strip(),
            'FROZEN_RELEASE_APPROVAL_REFERENCE_REQUIRED')
    sources = release.get('sources', {})
    require(set(sources) == set(RUNTIME), 'EXACT_RUNTIME_SOURCE_SET_REQUIRED')
    ui = release.get('ui', {})
    require(isinstance(ui, dict) and 'index.html' in ui and any(p.startswith('assets/') for p in ui)
            and any(p.startswith('fonts/') for p in ui), 'FINITE_APPROVED_UI_RECEIPT_REQUIRED')
    files = {}
    for path, expected in sources.items():
        data = safe_read(root, path)
        require(re.fullmatch('[0-9a-f]{64}', str(expected)) and digest(data) == expected,
                'SOURCE_HASH_MISMATCH:' + path)
        target = path.removeprefix('deployment/haldir-preview/') if path.endswith(('/package.json', '/package-lock.json')) else path
        files[target] = data
    for path, expected in ui.items():
        require(path == 'index.html' or re.fullmatch(r'(assets|fonts)/[A-Za-z0-9_./\[\]-]+\.(js|css|png|svg|ico|woff2?|ttf|txt|pb)', path),
                'UI_MEMBER_FORBIDDEN:' + path)
        source = 'deployment/haldir-preview/ui/' + path
        data = safe_read(root, source)
        require(re.fullmatch('[0-9a-f]{64}', str(expected)) and digest(data) == expected,
                'UI_HASH_MISMATCH:' + path)
        files[source] = data
    receipt_path = 'deployment/haldir-preview/ui-build-receipt.json'
    receipt_bytes = safe_read(root, receipt_path)
    require(digest(receipt_bytes) == release.get('uiBuildReceiptSha256'), 'UI_BUILD_RECEIPT_HASH_MISMATCH')
    receipt = json.loads(receipt_bytes)
    require(receipt.get('approvedOrigin') == release['approvedOrigin']
            and receipt.get('viteApprovedOrigin') == release['approvedOrigin']
            and receipt.get('outputs') == ui, 'UI_BUILD_RECEIPT_BINDING_MISMATCH')
    files[receipt_path] = receipt_bytes
    package = json.loads(files['package.json'])
    lock = json.loads(files['package-lock.json'])
    require(package.get('engines', {}).get('node') == '26.13.1', 'EXACT_NODE_PIN_REQUIRED')
    require(package.get('type') == 'module' and package.get('dependencies') == DEPS
            and not package.get('devDependencies') and not package.get('optionalDependencies'),
            'MINIMAL_EXACT_RUNTIME_MANIFEST_REQUIRED')
    require(lock.get('lockfileVersion') == 3 and lock.get('packages', {}).get('', {}).get('dependencies') == DEPS,
            'MATCHING_RUNTIME_LOCK_REQUIRED')
    for path, item in lock['packages'].items():
        if path:
            require(path.startswith('node_modules/') and not item.get('link') and
                    str(item.get('resolved', '')).startswith('https://registry.npmjs.org/') and
                    re.fullmatch(r'sha512-[A-Za-z0-9+/=]+', item.get('integrity', '')),
                    'LOCK_NONREGISTRY_OR_UNVERIFIED_ENTRY:' + path)
    return files


def assemble(root, release, output):
    require(not output.exists(), 'OUTPUT_ALREADY_EXISTS')
    files = validate_release(root, release)
    files['Dockerfile'] = (HERE / 'Dockerfile').read_bytes()
    files['cloudbuild.json'] = (HERE / 'cloudbuild.json').read_bytes()
    # Deny all, then admit the exact files and only their ancestor directories.
    allowed_dirs = set()
    for path in files:
        allowed_dirs.update(str(x) + '/' for x in PurePosixPath(path).parents if str(x) != '.')
    lines = ['**', '!/.dockerignore', '!/.gcloudignore']
    lines += ['!/' + p for p in sorted(allowed_dirs, key=lambda p: (p.count('/'), p))]
    lines += ['!/' + p.replace('[', r'\[').replace(']', r'\]') for p in sorted(files)]
    ignores = ('\n'.join(lines) + '\n').encode()
    files['.dockerignore'] = ignores
    # gcloud unescapes backslashes before fnmatch; bracket classes preserve literals.
    files['.gcloudignore'] = ignores.replace(b'\\[', b'[[]').replace(b'\\]', b'[]]')
    # Validate everything before creating a stage; never copy a directory recursively.
    output.mkdir(parents=True)
    for relative, data in files.items():
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    receipt = {'status': 'ASSEMBLED_ONLY_NOT_BUILT_OR_DEPLOYED',
               'releaseApprovalReference': release['approvalReference'],
               'approvedOrigin': release['approvedOrigin'],
               'files': {p: digest(b) for p, b in sorted(files.items())}}
    (output.parent / (output.name + '.receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def gcloud_account():
    """Read explicit nonsecret operator identity only when rendering commands."""
    account = os.environ.get('HALDIR_GCLOUD_ACCOUNT', '')
    require(isinstance(account, str) and bool(account), 'EXPLICIT_HALDIR_GCLOUD_ACCOUNT_REQUIRED')
    # Conservative ASCII mailbox syntax; never trim, normalize, or infer identity.
    require(len(account) <= 254 and len(account.partition('@')[0]) <= 64
            and '..' not in account and '.@' not in account
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*@'
                             r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+'
                             r'[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', account),
            'VALID_HALDIR_GCLOUD_ACCOUNT_EMAIL_REQUIRED')
    return account


def gc(*args):
    return ['gcloud', *args, '--account=' + gcloud_account(), '--project=' + PROJECT, '--quiet']


def readbacks():
    return [gc('services', 'list', '--enabled', '--limit=100', '--format=json'),
            gc('projects', 'get-iam-policy', PROJECT, '--format=json'),
            gc('iam', 'service-accounts', 'list', '--limit=30', '--format=json'),
            *[gc('resource-manager', 'org-policies', 'describe', p, '--effective', '--format=json') for p in POLICIES],
            gc('artifacts', 'repositories', 'list', '--location=' + REGION, '--limit=20', '--format=json'),
            gc('firestore', 'databases', 'describe', '--database=haldir', '--format=json'),
            gc('storage', 'buckets', 'describe', BUCKET, '--format=json'),
            *[gc('compute', *leaf, '--limit=30', '--format=json') for leaf in
              [('networks', 'list'), ('networks', 'subnets', 'list'), ('firewall-rules', 'list'), ('routes', 'list')]],
            *[gc('iam', 'service-accounts', 'keys', 'list', '--iam-account=' + sa, '--format=json')
              for sa in (BUILD_SA, RUNTIME_SA)]]


def foundation():
    account = gcloud_account()
    condition = 'expression=resource.name=="projects/' + PROJECT + '/databases/haldir",title=haldir-only'
    resources = [gc('iam', 'service-accounts', 'create', 'haldir-build', '--display-name=Haldir build only'),
                 gc('iam', 'service-accounts', 'create', 'haldir-runtime', '--display-name=Haldir authentication preview'),
                 gc('artifacts', 'repositories', 'create', 'haldir-preview', '--repository-format=docker', '--location=' + REGION),
                 gc('storage', 'buckets', 'create', BUCKET, '--location=' + REGION,
                    '--uniform-bucket-level-access', '--public-access-prevention', '--default-storage-class=STANDARD'),
                 gc('firestore', 'databases', 'create', '--database=haldir', '--location=' + REGION,
                    '--type=firestore-native', '--edition=standard', '--delete-protection')]
    iam = [gc('artifacts', 'repositories', 'add-iam-policy-binding', 'haldir-preview', '--location=' + REGION,
              '--member=serviceAccount:' + BUILD_SA, '--role=roles/artifactregistry.writer'),
           gc('projects', 'add-iam-policy-binding', PROJECT, '--member=serviceAccount:' + BUILD_SA,
              '--role=roles/logging.logWriter', '--condition=None'),
           gc('projects', 'add-iam-policy-binding', PROJECT, '--member=serviceAccount:' + RUNTIME_SA,
              '--role=roles/datastore.user', '--condition=' + condition),
           gc('storage', 'buckets', 'add-iam-policy-binding', BUCKET,
              '--member=serviceAccount:' + BUILD_SA, '--role=roles/storage.objectViewer'),
           *[gc('storage', 'buckets', 'add-iam-policy-binding', BUCKET,
                '--member=user:' + account, '--role=' + role)
             for role in ('roles/storage.objectCreator', 'roles/storage.objectViewer')]]
    return {'status': 'PROPOSAL_ONLY_NO_EXECUTOR',
            'authority': 'Requires separate visible mutation approval. Project and billing creation/linkage are intentionally absent.',
            'policyReadback': readbacks()[3:12],
            'enableMissingOnlyAfterPolicyAndBudgetGate': gc('services', 'enable', *APIS),
            'mandatoryCheckpointBeforeResourceOrIAMWrites': readbacks(),
            'createOnlyIfExactResourceAbsent': resources,
            'iamOnlyAfterResourceReadbackAndPermissionTests': iam,
            'independentReadbackAfterEachWrite': readbacks(),
            'additionalExactIamReadbacks': [*[gc('iam', 'service-accounts', 'get-iam-policy', sa, '--format=json')
                                              for sa in (BUILD_SA, RUNTIME_SA)],
                                            gc('artifacts', 'repositories', 'describe', 'haldir-preview', '--location=' + REGION, '--format=json'),
                                            gc('artifacts', 'repositories', 'get-iam-policy', 'haldir-preview', '--location=' + REGION, '--format=json'),
                                            gc('storage', 'buckets', 'get-iam-policy', BUCKET, '--format=json')]}


def build_commands(stage):
    require(stage.is_dir() and stage.parent == HERE / 'stage', 'APPROVED_LOCAL_STAGE_REQUIRED')
    receipt_path = stage.parent / (stage.name + '.receipt.json')
    receipt = json.loads(receipt_path.read_text())
    actual = {str(p.relative_to(stage)): digest(p.read_bytes()) for p in stage.rglob('*') if p.is_file()}
    require(not any(p.is_symlink() for p in stage.rglob('*')), 'STAGE_SYMLINK_FORBIDDEN')
    require(actual == receipt['files'], 'STAGE_MEMBERSHIP_OR_HASH_CHANGED')
    return {'prerequisites': ['Parent must verify approved-currency gross-cost alerts excluding credits, all-service project scope and recipients; preserve the separate USD50 whole-task ceiling and remaining exposure before submission.',
                              'Freeze expiry/shutdown responsibility, one build attempt, foundation and IAM readbacks, exact source/UI/adapter qualification.',
                              'Cloud Build service agent and Cloud Run service agent roles must be independently verified after API enablement; never grant build account Run/IAM permissions.'],
            'submitOneBuild': gc('builds', 'submit', str(stage), '--config=' + str(stage / 'cloudbuild.json'),
                                 '--region=' + REGION, '--timeout=600s', '--service-account=projects/' + PROJECT + '/serviceAccounts/' + BUILD_SA,
                                 '--gcs-source-staging-dir=' + BUCKET + '/source', '--ignore-file=' + str(stage / '.gcloudignore'), '--async')}


def deploy_commands(origin, image, revision):
    approved_origin(origin)
    require(re.fullmatch(re.escape(IMAGE) + r'@sha256:[0-9a-f]{64}', image), 'QUALIFIED_HALDIR_IMAGE_DIGEST_REQUIRED')
    require(re.fullmatch(r'[a-z][a-z0-9-]{0,29}[a-z0-9]', revision), 'BOUNDED_NAMED_REVISION_SUFFIX_REQUIRED')
    env = ','.join(['GOOGLE_CLOUD_PROJECT=' + PROJECT, 'HALDIR_PROJECT_NUMBER=' + NUMBER,
                    'HALDIR_REGION=' + REGION, 'HALDIR_FIRESTORE_DATABASE_ID=haldir',
                    'HALDIR_APPROVED_ORIGIN=' + origin])
    return {'status': 'PROPOSAL_ONLY_NO_EXECUTOR',
            'prerequisites': ['Exact approved origin from provider readback or current official deterministic-URL contract; freeze UI receipt and verify actual service URL after deployment. Never infer a hash-based URL or claim prospective reachability.',
                              'Actual successful build result image digest, image qualification and Firestore readiness acceptance.',
                              'Fresh effective policy permits public service; run.managed.requireInvokerIam must not be enforced.',
                              'Parent-owned approved-currency gross-cost alerts read back BEFORE build and BEFORE deploy; separate USD50 whole-task ceiling, operator expiry and remaining envelope verified.',
                              'This is public authentication-only exposure. No allUsers binding, org-policy changes, financial routes, secrets or worker.'],
            'oneDeployment': gc('run', 'deploy', SERVICE, '--region=' + REGION, '--image=' + image,
                                '--service-account=' + RUNTIME_SA, '--execution-environment=gen2',
                                '--min=0', '--max=1', '--min-instances=0', '--max-instances=1',
                                '--concurrency=4', '--timeout=30s', '--cpu=1', '--memory=512Mi',
                                '--cpu-throttling', '--no-cpu-boost', '--port=8080', '--ingress=all',
                                '--no-invoker-iam-check', '--revision-suffix=' + revision, '--set-env-vars=' + env,
                                '--startup-probe=httpGet.path=/healthz,httpGet.port=8080,initialDelaySeconds=5,timeoutSeconds=2,periodSeconds=5,failureThreshold=12'),
            'exactReadbacks': [gc('run', 'services', 'describe', SERVICE, '--region=' + REGION, '--format=json'),
                               gc('run', 'services', 'get-iam-policy', SERVICE, '--region=' + REGION, '--format=json'),
                               gc('run', 'revisions', 'describe', SERVICE + '-' + revision, '--region=' + REGION, '--format=json'),
                               gc('logging', 'read', 'resource.type="cloud_run_revision" AND resource.labels.service_name="' + SERVICE + '" AND resource.labels.revision_name="' + SERVICE + '-' + revision + '"', '--limit=50', '--format=json')]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    a = sub.add_parser('assemble'); a.add_argument('--release', required=True); a.add_argument('--name', required=True)
    sub.add_parser('foundation')
    i = sub.add_parser('inspect-build'); i.add_argument('--id', required=True)
    b = sub.add_parser('build'); b.add_argument('--stage', required=True)
    d = sub.add_parser('deploy'); d.add_argument('--origin', required=True); d.add_argument('--image', required=True); d.add_argument('--revision', required=True)
    d.add_argument('--stage', required=True); d.add_argument('--build-receipt', required=True)
    args = parser.parse_args()
    if args.action == 'assemble':
        require(re.fullmatch('[a-z0-9][a-z0-9-]{1,39}', args.name), 'SAFE_STAGE_NAME_REQUIRED')
        release = json.loads(Path(args.release).read_text())
        result = assemble(ROOT, release, HERE / 'stage' / args.name)
    elif args.action == 'foundation':
        result = foundation()
    elif args.action == 'inspect-build':
        require(re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', args.id), 'ACTUAL_BUILD_UUID_REQUIRED')
        result = {'buildReadback': gc('builds', 'describe', args.id, '--region=' + REGION, '--format=json'),
                  'registryReadback': gc('artifacts', 'docker', 'images', 'describe', IMAGE + ':' + args.id, '--format=json')}
    elif args.action == 'build':
        result = build_commands(Path(args.stage).resolve())
    else:
        stage = Path(args.stage).resolve()
        build_commands(stage)  # Independently recheck exact stage membership and bytes.
        stage_receipt = json.loads((stage.parent / (stage.name + '.receipt.json')).read_text())
        require(stage_receipt['approvedOrigin'] == args.origin, 'UI_RELEASE_ORIGIN_MISMATCH')
        built = json.loads(Path(args.build_receipt).read_text())
        require(built.get('projectId') == PROJECT and built.get('status') == 'SUCCESS'
                and built.get('serviceAccount') == 'projects/' + PROJECT + '/serviceAccounts/' + BUILD_SA,
                'SUCCESSFUL_EXACT_BUILD_RECEIPT_REQUIRED')
        actual_images = {item.get('name', '').split(':')[0] + '@' + item.get('digest', '')
                         for item in built.get('results', {}).get('images', [])}
        require(args.image in actual_images, 'IMAGE_NOT_IN_SUCCESSFUL_BUILD_RESULTS')
        result = deploy_commands(args.origin, args.image, args.revision)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
