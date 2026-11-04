"""Build a data-free installable release from the current saved source tree."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_manifest(root,metadata):
    package=root/'agent_framework'
    if package.is_symlink():raise ValueError('package root must not be a symlink')
    paths=[]
    for path in sorted(package.rglob('*')):
        relative=path.relative_to(package)
        if '__pycache__' in relative.parts or path.name=='.DS_Store' or path.suffix=='.pyc':continue
        if path.is_symlink() or not(path.is_file() or path.is_dir()):raise ValueError('unsupported package entry: '+str(relative))
        if path.is_file():paths.append(path)
    allowed={path for path in paths if path.suffix=='.py'}
    for pattern in metadata['tool']['setuptools']['package-data']['agent_framework']:
        allowed.update(path for path in package.glob(pattern) if path.is_file())
    unexpected=set(paths)-allowed
    if unexpected:raise ValueError('unregistered package data: '+str(min(unexpected).relative_to(package)))
    return {str(path.relative_to(root)):sha256(path) for path in paths}


@contextmanager
def output_lock(directory):
    with (directory/'.release-build.lock').open('a+b') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise RuntimeError('another release build is using this output directory') from None
        try:yield
        finally:fcntl.flock(lock,fcntl.LOCK_UN)


def publish(source,target):
    """Publish one complete file without replacing an existing artifact."""
    with tempfile.NamedTemporaryFile(prefix='.release-',dir=target.parent,delete=False) as temporary:
        staging=Path(temporary.name)
    try:
        shutil.copyfile(source,staging)
        with staging.open('rb') as completed:os.fsync(completed.fileno())
        os.link(staging,target)
    finally:staging.unlink(missing_ok=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,help='Separate output directory for a source candidate; existing artifacts are never replaced')
    args=parser.parse_args()
    metadata=tomllib.loads((ROOT/'pyproject.toml').read_text())
    version = metadata['project']['version']
    # Check source metadata without importing an installed (possibly older) copy.
    namespace = {}
    exec((ROOT / 'agent_framework/__init__.py').read_text(), namespace)
    if namespace['__version__'] != version:
        raise ValueError('package versions differ')
    dist = (args.output_dir or ROOT/'dist').resolve()
    dist.mkdir(parents=True,exist_ok=True)
    with output_lock(dist):build(metadata,version,dist)


def build(metadata,version,dist):
    if (dist / ('agent-framework-' + version + '.tar.gz')).exists() or any(dist.glob('bounded_agent_mvp-' + version + '-*.whl')):
        raise FileExistsError('release already exists; use a new version instead of overwriting published artifacts')
    current_source=source_manifest(ROOT,metadata)
    with tempfile.TemporaryDirectory(prefix='agent-release-') as temporary:
        staging = Path(temporary)
        # Build from a clean source snapshot, never from a stale build/lib tree.
        source_root = staging / 'source'
        source_root.mkdir()
        shutil.copy2(ROOT / 'pyproject.toml', source_root / 'pyproject.toml')
        shutil.copytree(ROOT / 'agent_framework', source_root / 'agent_framework',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        source = source_manifest(source_root,metadata)
        if source!=current_source:raise ValueError('source changed while taking the release snapshot')
        subprocess.run([sys.executable, '-I', '-m', 'pip', 'wheel', '--no-index', '--no-deps', '--no-build-isolation',
                        '--wheel-dir', str(staging), str(source_root)], check=True)
        wheel, = staging.glob('*.whl')
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()
            if any(not (n.startswith('agent_framework/') or n.startswith('bounded_agent_mvp-'))
                   or any(p in n.split('/') for p in ('.agent-data', '.backups', '__pycache__'))
                   or n.endswith(('.sqlite3', '.sqlite3-wal', '.sqlite3-shm', '.pyc')) for n in names):
                raise ValueError('unexpected runtime/private file in wheel')
            required = ['agent_framework/webui/index.html', 'agent_framework/webui/skills.js',
                        'agent_framework/webui/journeys.js', 'agent_framework/webui/learning.js',
                        'agent_framework/learning.py', 'agent_framework/ontology.py',
                        'agent_framework/ontology_model.py','agent_framework/ontology_evidence.py',
                        'agent_framework/model_execution.py','agent_framework/task_conversations.py',
                        'agent_framework/webui/ontology_model.js','agent_framework/webui/ontology_evidence.js',
                        'agent_framework/webui/hig.css', 'agent_framework/webui/appearance.js',
                        'agent_framework/webui/workflow_designer.js',
                        'agent_framework/resources/skills/release-risk-analysis/SKILL.md',
                        'agent_framework/resources/skills/source-grounded-answer/SKILL.md']
            if not all(n in names for n in required):
                raise ValueError('missing application resources')
            packaged = {n: hashlib.sha256(archive.read(n)).hexdigest()
                        for n in names if n.startswith('agent_framework/') and not n.endswith('/')}
            if packaged != source:
                raise ValueError('wheel resources differ from the current source snapshot')
        bundle = staging / ('agent-framework-' + version)
        bundle.mkdir()
        shutil.copy2(wheel, bundle / wheel.name)
        (bundle / 'scripts').mkdir()
        for name in ('install.sh', 'start.sh'):
            shutil.copy2(ROOT / 'scripts' / name, bundle / 'scripts' / name)
        shutil.copy2(ROOT / 'docs/release/INSTALL.md', bundle / 'README.md')
        shutil.copy2(ROOT / 'docs/release/RELEASE_NOTES.md', bundle / 'RELEASE_NOTES.md')
        (bundle / 'requirements.txt').write_text('PyYAML==6.0.3\n' + str('./' + wheel.name) + '\n')
        # pip resolves relative wheel entries from cwd; installer runs from the bundle root.
        (bundle / 'release.json').write_text(json.dumps({
            'version': version, 'built_at': datetime.now(timezone.utc).isoformat(),
            'business_tools': 'simulated', 'access': 'single-user-loopback',
            'contains_runtime_data': False, 'wheel': wheel.name, 'wheel_sha256': sha256(wheel),
            'source_sha256': source, 'built_from':'saved-working-tree',
        }, ensure_ascii=False, indent=2) + '\n')
        members = sorted(p for p in bundle.rglob('*') if p.is_file())
        (bundle / 'SHA256SUMS').write_text(''.join(sha256(p) + '  ' + str(p.relative_to(bundle)) + '\n' for p in members))
        if source_manifest(ROOT,metadata)!=current_source:raise ValueError('source changed during release construction; rebuild the candidate')
        completed = staging / (bundle.name + '.tar.gz')
        with tarfile.open(completed, 'w:gz') as archive:
            archive.add(bundle, arcname=bundle.name)
        target = dist / completed.name
        publish(completed,target)
        publish(wheel,dist/wheel.name)
        artifacts = sorted([*dist.glob('agent-framework-*.tar.gz'), *dist.glob('bounded_agent_mvp-*.whl')])
        checksums=staging/'SHA256SUMS'
        checksums.write_text(''.join(sha256(p) + '  ' + p.name + '\n' for p in artifacts))
        with tempfile.NamedTemporaryFile(prefix='.release-checksums-',dir=dist,delete=False) as temporary:
            checksum_target=Path(temporary.name)
        try:
            shutil.copyfile(checksums,checksum_target)
            with checksum_target.open('rb') as completed:os.fsync(completed.fileno())
            os.replace(checksum_target,dist/'SHA256SUMS')
        finally:checksum_target.unlink(missing_ok=True)
        print(json.dumps({'version': version, 'bundle': str(target), 'sha256': sha256(target),
                          'wheel': str(dist / wheel.name), 'runtime_data_included': False}, indent=2))


if __name__ == '__main__':
    main()
