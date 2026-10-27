"""Build a data-free installable release from the current saved source tree."""
from datetime import datetime, timezone
import hashlib
import json
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


def main():
    version = tomllib.loads((ROOT / 'pyproject.toml').read_text())['project']['version']
    # Check source metadata without importing an installed (possibly older) copy.
    namespace = {}
    exec((ROOT / 'agent_framework/__init__.py').read_text(), namespace)
    if namespace['__version__'] != version:
        raise ValueError('package versions differ')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    if (dist / ('agent-framework-' + version + '.tar.gz')).exists() or any(dist.glob('bounded_agent_mvp-' + version + '-*.whl')):
        raise FileExistsError('release already exists; use a new version instead of overwriting published artifacts')
    with tempfile.TemporaryDirectory(prefix='agent-release-') as temporary:
        staging = Path(temporary)
        # Build from a clean source snapshot, never from a stale build/lib tree.
        source_root = staging / 'source'
        source_root.mkdir()
        shutil.copy2(ROOT / 'pyproject.toml', source_root / 'pyproject.toml')
        shutil.copytree(ROOT / 'agent_framework', source_root / 'agent_framework',
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '.DS_Store'))
        source = {str(p.relative_to(source_root)): sha256(p)
                  for p in sorted((source_root / 'agent_framework').rglob('*')) if p.is_file()}
        subprocess.run([sys.executable, '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation',
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
            'source_sha256': source,
        }, ensure_ascii=False, indent=2) + '\n')
        members = sorted(p for p in bundle.rglob('*') if p.is_file())
        (bundle / 'SHA256SUMS').write_text(''.join(sha256(p) + '  ' + str(p.relative_to(bundle)) + '\n' for p in members))
        target = dist / (bundle.name + '.tar.gz')
        with tarfile.open(target, 'w:gz') as archive:
            archive.add(bundle, arcname=bundle.name)
        shutil.copy2(wheel, dist / wheel.name)
        artifacts = sorted([*dist.glob('agent-framework-*.tar.gz'), *dist.glob('bounded_agent_mvp-*.whl')])
        (dist / 'SHA256SUMS').write_text(''.join(sha256(p) + '  ' + p.name + '\n' for p in artifacts))
        print(json.dumps({'version': version, 'bundle': str(target), 'sha256': sha256(target),
                          'wheel': str(dist / wheel.name), 'runtime_data_included': False}, indent=2))


if __name__ == '__main__':
    main()
