#!/usr/bin/env python3
"""CYBER//LAB 本机 Cloud Run 运维工作台（仅标准库）。"""

from __future__ import annotations

import collections
import datetime as dt
import http.server
import json
import os
import pathlib
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser


ROOT = pathlib.Path(__file__).resolve().parent
PROJECT_ID = 'karas-513205'
REGION = 'us-central1'
SERVICE = 'cyber-lab'
INSTANCE = 'karas-513205:us-central1:super-roach-db'
DATABASE = 'cyber_lab'
DB_USER = 'cyber-lab-runtime@karas-513205.iam'
RUNTIME_SERVICE_ACCOUNT = 'cyber-lab-runtime@karas-513205.iam.gserviceaccount.com'
MAX_LOG_LINES = 180
MAX_LINE_CHARS = 1_200
STATUS_CACHE_SECONDS = 12

ALLOWED_EXACT_PATHS = {
    '.codex/config.toml',
    '.gcloudignore',
    '.gitignore',
    'Dockerfile',
    'README.md',
    'TECHNICAL_DOC.md',
    'AGENTS.md',
    'app.js',
    'cloud_run_ops_workbench.py',
    'cloud-functions/api/chat.js',
    'cloudrun/server.mjs',
    'edgeone.json',
    'index.html',
    'package-lock.json',
    'package.json',
    'scripts/build-static.mjs',
    'style.css',
    '一键更新至CloudRun批处理工作台.command',
    'tests/contract/chat-paths.test.ts',
    'tests/unit/cloudrun-server.test.js',
}
ALLOWED_PATH_PREFIXES = (
    'agents/',
    'cloud-functions/',
    'scripts/core/',
    'scripts/ui/',
    'styles/',
)
NEVER_STAGE_NAMES = {
    'credentials.json', 'service-account.json', '.npmrc', '.netrc', '.pypirc',
    'id_rsa', 'id_ed25519',
}
NEVER_STAGE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx'}

_csrf_token = secrets.token_urlsafe(32)
_job_lock = threading.Lock()
_job_guard = threading.Lock()
_active_job: dict | None = None
_status_guard = threading.Lock()
_status_refresh_lock = threading.Lock()
_status_cache: tuple[float, dict] | None = None

ANSI_RE = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
CONTROL_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')
SECRET_ASSIGNMENT_RE = re.compile(
    r'(?i)(\b(?:AI_GATEWAY_API_KEY|api[_-]?key|access[_-]?token|refresh[_-]?token|'
    r'password|passwd|secret|authorization)\b\s*[:=]\s*)([^\s,;]+)'
)
BEARER_RE = re.compile(r'(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+')
TOKEN_RE = re.compile(r'\b(?:ya29\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b')
QUERY_SECRET_RE = re.compile(r'(?i)([?&](?:key|token|access_token|api_key)=)[^&\s]+')
STAGED_SECRET_RE = re.compile(
    r'''(?im)(?:AI_GATEWAY_API_KEY\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{32,}|'''
    r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
    r'\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,})\b)'
)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def redact(value: str) -> str:
    value = ANSI_RE.sub('', value)
    value = CONTROL_RE.sub('', value)
    value = SECRET_ASSIGNMENT_RE.sub(r'\1<已隐藏>', value)
    value = BEARER_RE.sub('Bearer <已隐藏>', value)
    value = TOKEN_RE.sub('<已隐藏凭据>', value)
    value = QUERY_SECRET_RE.sub(r'\1<已隐藏>', value)
    return value[:MAX_LINE_CHARS]


def append_log(job: dict, message: str) -> None:
    safe = redact(message).strip()
    if not safe:
        return
    with _job_guard:
        job['logs'].append({'time': now_iso(), 'text': safe})
        if len(job['logs']) > MAX_LOG_LINES:
            del job['logs'][:-MAX_LOG_LINES]


class OperationError(RuntimeError):
    pass


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def command_available(name: str) -> bool:
    return shutil.which(name) is not None


def child_environment() -> dict[str, str]:
    """Keep normal login/config paths, while removing shell, Git and token overrides."""
    env = os.environ.copy()
    blocked = {
        'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
        'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'ACCESS_TOKEN',
        'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG',
        'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS',
        'GIT_EXEC_PATH', 'GIT_PREFIX', 'NODE_OPTIONS', 'NODE_PATH',
        'NPM_CONFIG_USERCONFIG', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV',
        'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
    }
    for key in tuple(env):
        if key in blocked or key.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_')):
            env.pop(key, None)
    env['GIT_TERMINAL_PROMPT'] = '0'
    return env


def run_process(
    job: dict,
    label: str,
    argv: list[str],
    *,
    timeout: int = 900,
    env: dict[str, str] | None = None,
    output_mode: str = 'tail',
) -> tuple[int, str]:
    """只执行调用方定义的 argv，不经过 shell；日志与失败信息均脱敏。"""
    append_log(job, f'▶ {label}')
    try:
        process = subprocess.Popen(
            argv,
            cwd=ROOT,
            env=env or child_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=1,
        )
    except (OSError, ValueError) as exc:
        append_log(job, f'✖ 无法启动 {label}：{type(exc).__name__}')
        raise OperationError(f'无法启动：{label}') from None

    output_lines: collections.deque[str] = collections.deque(maxlen=80)
    try:
        output, _ = process.communicate(timeout=timeout)
        for line in output.splitlines()[-80:]:
            safe = redact(line)
            if safe:
                output_lines.append(safe)
        code = process.returncode
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        append_log(job, f'✖ {label} 超时，进程已停止')
        raise OperationError(f'{label} 超时') from None
    except OperationError:
        raise
    except Exception:
        process.kill()
        process.communicate()
        append_log(job, f'✖ {label} 中断')
        raise OperationError(f'{label} 中断') from None

    captured = '\n'.join(output_lines)
    if output_mode == 'tail':
        for line in list(output_lines)[-18:]:
            append_log(job, line)
    if code != 0:
        append_log(job, f'✖ {label} 失败（退出码 {code}）')
        raise OperationError(f'{label} 失败，退出码 {code}')
    append_log(job, f'✓ {label} 完成')
    return code, captured


def capture(argv: list[str], *, timeout: int = 18) -> tuple[int, str]:
    """只读状态查询；不把完整 gcloud/Git 输出写进服务日志。"""
    try:
        result = subprocess.run(
            argv,
            cwd=ROOT,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            env=child_environment(),
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 127, ''
    return result.returncode, result.stdout.strip()


def parse_status_paths(raw: bytes) -> list[tuple[str, str]]:
    """解析 git status --porcelain -z；返回状态和文件相对路径。"""
    fields = raw.split(b'\0')
    changes: list[tuple[str, str]] = []
    index = 0
    while index < len(fields):
        field = fields[index]
        index += 1
        if not field:
            continue
        if len(field) < 4 or field[2:3] != b' ':
            raise OperationError('Git 工作区状态无法安全解析，已停止发布')
        status = field[:2].decode('ascii', errors='replace')
        path = os.fsdecode(field[3:])
        if 'R' in status or 'C' in status:
            raise OperationError('检测到重命名或复制文件，请先人工整理后再发布')
        if 'U' in status or status in ('AA', 'DD'):
            raise OperationError('Git 存在未解决的合并冲突')
        changes.append((status, path))
    return changes


def path_is_allowed(relative_path: str) -> bool:
    path = pathlib.PurePosixPath(relative_path)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    if any(
        part in NEVER_STAGE_NAMES
        or part.startswith('.env')
        or pathlib.PurePosixPath(part).suffix.lower() in NEVER_STAGE_SUFFIXES
        for part in path.parts
    ):
        return False
    if any(part == '.edgeone' or part == 'node_modules' or part == '.git' for part in path.parts):
        return False
    if relative_path in ALLOWED_EXACT_PATHS:
        return True
    return any(relative_path.startswith(prefix) for prefix in ALLOWED_PATH_PREFIXES)


def git_changes() -> list[tuple[str, str]]:
    try:
        result = subprocess.run(
            ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
            cwd=ROOT,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            env=child_environment(),
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    try:
        return parse_status_paths(result.stdout)
    except OperationError:
        return []


def ensure_git_release_safe(job: dict) -> str:
    branch_code, branch = capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    if branch_code != 0 or branch != 'main':
        raise OperationError('当前分支不是 main；未推送或部署')

    staged_code, _ = capture(['git', 'diff', '--cached', '--quiet'], timeout=15)
    if staged_code == 1:
        raise OperationError('发现用户已暂存的改动；为保留原暂存区，已停止发布')
    if staged_code != 0:
        raise OperationError('无法检查 Git 暂存区')

    try:
        status_result = subprocess.run(
            ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
            cwd=ROOT,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            env=child_environment(),
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise OperationError('无法读取 Git 工作区状态；未推送或部署') from None
    if status_result.returncode != 0:
        raise OperationError('无法读取 Git 工作区状态；未推送或部署')
    changes = parse_status_paths(status_result.stdout)
    unsafe = [path for _, path in changes if not path_is_allowed(path)]
    if unsafe:
        listing = '、'.join(unsafe[:8])
        suffix = f'等 {len(unsafe)} 个文件' if len(unsafe) > 8 else ''
        raise OperationError(f'工作区包含发布白名单之外的改动：{listing}{suffix}。未推送或部署')

    fetch_code, _ = capture(['git', 'fetch', '--quiet', 'origin', 'main'], timeout=90)
    if fetch_code != 0:
        raise OperationError('无法读取 origin/main；未推送或部署')
    ancestor_code, _ = capture(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
    if ancestor_code != 0:
        raise OperationError('本地 main 与 origin/main 已分叉或落后；请先人工同步 Git')

    if changes:
        paths = [path for _, path in changes]
        run_process(job, '暂存项目白名单文件', ['git', 'add', '--', *paths], timeout=60, output_mode='none')
        try:
            staged_result = subprocess.run(
                ['git', 'diff', '--cached', '--name-only', '-z'],
                cwd=ROOT, capture_output=True, timeout=20, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise OperationError('无法验证暂存清单') from None
        if staged_result.returncode != 0:
            raise OperationError('无法验证暂存清单')
        staged_paths = [os.fsdecode(item) for item in staged_result.stdout.split(b'\0') if item]
        if set(staged_paths) != set(paths) or any(not path_is_allowed(path) for path in staged_paths):
            raise OperationError('暂存区出现白名单外文件；已停止提交')
        unstaged_code, _ = capture(['git', 'diff', '--quiet'])
        if unstaged_code != 0:
            raise OperationError('暂存期间工作区又发生变化；已停止提交')
        staged_check_code, _ = capture(['git', 'diff', '--cached', '--check'])
        if staged_check_code != 0:
            raise OperationError('暂存内容空白检查失败')
        try:
            staged_diff = subprocess.run(
                ['git', 'diff', '--cached', '--no-ext-diff', '--unified=0'],
                cwd=ROOT, capture_output=True, timeout=30, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise OperationError('无法检查暂存内容的密钥风险') from None
        if staged_diff.returncode != 0:
            raise OperationError('无法检查暂存内容的密钥风险')
        if STAGED_SECRET_RE.search(staged_diff.stdout.decode('utf-8', errors='replace')):
            raise OperationError('暂存差异疑似包含凭据；已停止提交，未显示敏感内容')
        run_process(
            job,
            '创建中文 Git 提交',
            ['git', 'commit', '-m', '发布 CYBER//LAB 到 Google Cloud Run'],
            timeout=120,
            output_mode='tail',
        )

    sha_code, sha = capture(['git', 'rev-parse', '--short=12', 'HEAD'])
    if sha_code != 0 or not re.fullmatch(r'[0-9a-f]{7,40}', sha):
        raise OperationError('无法读取待部署 Git 提交')
    run_process(job, '推送 main 到 origin', ['git', 'push', 'origin', 'main'], timeout=300, output_mode='tail')
    return sha


def check_cloud_prerequisites(job: dict) -> None:
    if not command_available('gcloud'):
        raise OperationError('本机未找到 gcloud CLI；未推送或部署')
    account_code, active_account = capture(
        ['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']
    )
    if account_code != 0 or not active_account:
        raise OperationError('gcloud 没有活动登录账号；未推送或部署')
    instance_code, _ = capture([
        'gcloud', 'sql', 'instances', 'describe', 'super-roach-db',
        '--project', PROJECT_ID, '--format=json',
    ], timeout=30)
    if instance_code != 0:
        raise OperationError('Cloud SQL 实例不可读；未推送或部署')
    db_code, _ = capture([
        'gcloud', 'sql', 'databases', 'describe', DATABASE,
        '--instance', 'super-roach-db', '--project', PROJECT_ID, '--format=json',
    ], timeout=30)
    if db_code != 0:
        raise OperationError('Cloud SQL 数据库 cyber_lab 不存在或不可读；未推送或部署')
    users_code, users_raw = capture([
        'gcloud', 'sql', 'users', 'list', '--instance', 'super-roach-db',
        '--project', PROJECT_ID, '--format=json',
    ], timeout=30)
    if users_code != 0:
        raise OperationError('无法确认 Cloud SQL IAM 数据库用户；未推送或部署')
    try:
        users = json.loads(users_raw)
    except json.JSONDecodeError:
        raise OperationError('Cloud SQL 用户清单无法解析；未推送或部署') from None
    if not any(
        isinstance(user, dict)
        and user.get('name') == DB_USER
        and str(user.get('type', '')).upper() in ('CLOUD_IAM_SERVICE_ACCOUNT', 'CLOUD_IAM_SERVICE_ACCOUNT_USER')
        for user in (users if isinstance(users, list) else [])
    ):
        raise OperationError('Cloud SQL IAM 数据库用户 cyber-lab-runtime 尚未创建；未推送或部署')
    sa_code, _ = capture([
        'gcloud', 'iam', 'service-accounts', 'describe', RUNTIME_SERVICE_ACCOUNT,
        '--project', PROJECT_ID, '--format=json',
    ], timeout=30)
    if sa_code != 0:
        raise OperationError('Cloud Run runtime service account 不存在或不可读；未推送或部署')
    secret_code, _ = capture([
        'gcloud', 'secrets', 'describe', 'cyber-lab-ai-gateway-key',
        '--project', PROJECT_ID, '--format=json',
    ], timeout=30)
    if secret_code != 0:
        raise OperationError('AI Gateway Secret Manager secret 不存在或不可读；未推送或部署')
    version_code, enabled_version = capture([
        'gcloud', 'secrets', 'versions', 'list', 'cyber-lab-ai-gateway-key',
        '--project', PROJECT_ID, '--filter=state=ENABLED', '--limit=1', '--format=value(name)',
    ], timeout=30)
    if version_code != 0 or not enabled_version:
        raise OperationError('AI Gateway secret 尚无可用版本；未推送或部署')
    validate_existing_service_configuration(job)
    append_log(job, '✓ gcloud 登录和 Cloud SQL 目标已就绪')


def parse_service(raw: str) -> dict:
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict):
        return {}
    status = value.get('status') if isinstance(value.get('status'), dict) else {}
    url = value.get('uri') or status.get('url')
    revision = value.get('latestReadyRevision') or status.get('latestReadyRevisionName')
    conditions = value.get('conditions') or status.get('conditions') or []
    ready = any(
        isinstance(item, dict)
        and item.get('type') == 'Ready'
        and item.get('state', item.get('status')) in ('CONDITION_SUCCEEDED', 'True', True)
        for item in conditions
    )
    safe_url = None
    if isinstance(url, str):
        try:
            parsed_url = urllib.parse.urlsplit(url)
            if (
                parsed_url.scheme == 'https'
                and parsed_url.hostname
                and parsed_url.hostname.lower().endswith('.run.app')
                and not parsed_url.username
                and not parsed_url.password
                and not parsed_url.query
                and not parsed_url.fragment
            ):
                safe_url = urllib.parse.urlunsplit((parsed_url.scheme, parsed_url.netloc, parsed_url.path.rstrip('/'), '', ''))
        except ValueError:
            safe_url = None
    return {
        'url': safe_url,
        'revision': revision if isinstance(revision, str) else None,
        'ready': ready,
    }


def validate_existing_service_configuration(job: dict) -> None:
    code, raw = capture([
        'gcloud', 'run', 'services', 'describe', SERVICE,
        '--project', PROJECT_ID, '--region', REGION, '--format=json',
    ], timeout=30)
    if code != 0:
        raise OperationError('尚未完成 CYBER//LAB 首次 Cloud Run 初始化；未推送或部署')
    try:
        service = json.loads(raw)
    except json.JSONDecodeError:
        raise OperationError('无法验证 Cloud Run 当前配置；未推送或部署') from None
    if not isinstance(service, dict):
        raise OperationError('无法验证 Cloud Run 当前配置；未推送或部署')
    template = service.get('template')
    if not isinstance(template, dict):
        template = (service.get('spec') or {}).get('template') or {}
    if not isinstance(template, dict):
        raise OperationError('Cloud Run 服务模板无法读取；未推送或部署')
    inner_template = template.get('spec') if isinstance(template.get('spec'), dict) else {}
    runtime_account = template.get('serviceAccount') or inner_template.get('serviceAccountName')
    if runtime_account != RUNTIME_SERVICE_ACCOUNT:
        raise OperationError('Cloud Run runtime service account 与工作台目标不一致；未推送或部署')
    containers = template.get('containers') or inner_template.get('containers') or []
    environment = {}
    for container in containers:
        if not isinstance(container, dict):
            continue
        for item in container.get('env') or []:
            if isinstance(item, dict) and isinstance(item.get('name'), str):
                environment[item['name']] = item
    for required in ('AI_GATEWAY_BASE_URL', 'AI_GATEWAY_MODEL'):
        if required not in environment:
            raise OperationError(f'Cloud Run 未配置 {required}；未推送或部署')
    api_key = environment.get('AI_GATEWAY_API_KEY')
    source = (api_key or {}).get('valueSource') or (api_key or {}).get('valueFrom') or {}
    secret_ref = source.get('secretKeyRef') if isinstance(source, dict) else None
    reference = None
    if isinstance(secret_ref, dict):
        reference = secret_ref.get('secret') or secret_ref.get('name')
    if not isinstance(reference, str):
        raise OperationError('Cloud Run API key 未使用 Secret Manager 引用；未推送或部署')
    if reference != 'cyber-lab-ai-gateway-key' and not reference.endswith('/secrets/cyber-lab-ai-gateway-key'):
        raise OperationError('Cloud Run API key Secret Manager 名称不匹配；未推送或部署')
    service_status = parse_service(raw)
    if not service_status.get('url'):
        raise OperationError('Cloud Run 服务 URL 尚未就绪；未推送或部署')
    health = fetch_health(service_status['url'])
    if health.get('status') != 'ok' or health.get('database') != 'ok':
        raise OperationError('现有 Cloud Run 服务未通过 cyber_lab 数据库健康检查；未推送或部署')
    append_log(job, '✓ Cloud Run 已绑定 Secret Manager API key 与网关配置')
    append_log(job, '✓ 现有服务与 cyber_lab 数据库健康检查通过')


def fetch_health(url: str | None) -> dict:
    if not url:
        return {'reachable': False, 'database': 'unknown'}
    try:
        request = urllib.request.Request(url.rstrip('/') + '/api/health', headers={'Accept': 'application/json'})
        opener = urllib.request.build_opener(NoRedirectHandler())
        with opener.open(request, timeout=18) as response:
            value = json.loads(response.read(16_384).decode('utf-8'))
            return {
                'reachable': response.status == 200,
                'database': value.get('database', 'unknown') if isinstance(value, dict) else 'unknown',
                'status': value.get('status', 'unknown') if isinstance(value, dict) else 'unknown',
            }
    except (OSError, urllib.error.URLError, ValueError, TimeoutError):
        return {'reachable': False, 'database': 'unavailable', 'status': 'unavailable'}


def collect_status() -> dict:
    branch_code, branch = capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
    sha_code, sha = capture(['git', 'rev-parse', '--short=12', 'HEAD'])
    changes = git_changes()
    local_project_code, local_project = capture(['gcloud', 'config', 'get-value', 'project'])
    auth_code, active_account = capture(
        ['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']
    )
    service = {}
    if auth_code == 0 and active_account and command_available('gcloud'):
        service_code, service_raw = capture([
            'gcloud', 'run', 'services', 'describe', SERVICE,
            '--project', PROJECT_ID, '--region', REGION, '--format=json',
        ], timeout=30)
        if service_code == 0:
            service = parse_service(service_raw)
    health = fetch_health(service.get('url'))
    safe_project = local_project if local_project_code == 0 else ''
    if safe_project.lower() in ('(unset)', 'unset'):
        safe_project = ''
    return {
        'branch': branch if branch_code == 0 else '未知',
        'commit': sha if sha_code == 0 else '未知',
        'project': safe_project,
        'gcloudAuthenticated': auth_code == 0 and bool(active_account),
        'service': service,
        'health': health,
        'changes': [{'status': status, 'path': path} for status, path in changes[:80]],
        'changeCount': len(changes),
        'timestamp': now_iso(),
        'workbenchBusy': _job_lock.locked(),
    }


def get_status() -> dict:
    global _status_cache
    with _status_refresh_lock:
        now = time.monotonic()
        with _status_guard:
            if _status_cache and now - _status_cache[0] < STATUS_CACHE_SECONDS:
                return dict(_status_cache[1])
        status = collect_status()
        with _status_guard:
            _status_cache = (time.monotonic(), status)
        return status


def run_action(action: str, job: dict) -> None:
    if not command_available('npm'):
        raise OperationError('本机未找到 npm；请先安装 Node.js 22+。')
    run_process(job, '项目检查（含测试与差异空白检查）', ['npm', 'run', 'check'], timeout=900)
    if action in ('build', 'release'):
        run_process(job, '静态前端构建', ['npm', 'run', 'build'], timeout=180)
    if action != 'release':
        return
    check_cloud_prerequisites(job)
    commit_sha = ensure_git_release_safe(job)
    clean_code, remaining_changes = capture(['git', 'status', '--porcelain=v1', '--untracked-files=all'])
    if clean_code != 0 or remaining_changes:
        raise OperationError('Git 推送后工作区出现新改动，本次停止 Cloud Run 部署；已推送的提交保留')
    deploy_env = ','.join([
        'AI_GATEWAY_PREFER_AGENT_PROXY=false',
        f'INSTANCE_CONNECTION_NAME={INSTANCE}',
        f'DB_NAME={DATABASE}',
        f'DB_USER={DB_USER}',
        f'GIT_COMMIT={commit_sha}',
    ])
    deploy_args = [
        'gcloud', 'run', 'deploy', SERVICE,
        '--source', '.',
        '--project', PROJECT_ID,
        '--region', REGION,
        '--service-account', RUNTIME_SERVICE_ACCOUNT,
        '--set-cloudsql-instances', INSTANCE,
        '--update-env-vars', deploy_env,
        '--memory', '512Mi',
        '--max', '3',
        '--allow-unauthenticated',
        '--quiet',
    ]
    run_process(job, f'部署 Cloud Run（Git {commit_sha}）', deploy_args, timeout=1800, output_mode='tail')
    status_code, service_raw = capture([
        'gcloud', 'run', 'services', 'describe', SERVICE,
        '--project', PROJECT_ID, '--region', REGION, '--format=json',
    ], timeout=45)
    if status_code != 0:
        raise OperationError('部署命令已返回成功，但读取 Cloud Run 状态失败')
    service = parse_service(service_raw)
    if not service.get('url'):
        raise OperationError('部署已提交，但 Cloud Run 未返回服务地址')
    health = fetch_health(service['url'])
    append_log(job, f"Cloud Run 地址：{service['url']}")
    if health.get('status') == 'ok' and health.get('database') == 'ok':
        append_log(job, '✓ Cloud Run 与专用 Cloud SQL 数据库健康检查通过')
    else:
        append_log(job, '⚠ 服务已部署，但数据库健康检查未通过；请检查 Cloud Run 日志与 IAM 配置')


def worker(action: str, job: dict) -> None:
    try:
        run_action(action, job)
        job['status'] = 'succeeded'
        job['message'] = '流程已完成'
    except OperationError as exc:
        append_log(job, f'✖ {exc}')
        job['status'] = 'failed'
        job['message'] = str(exc)
    except Exception as exc:  # 仅向 UI 输出类别，不回显异常文本或堆栈
        append_log(job, f'✖ 流程中断（{type(exc).__name__}）')
        job['status'] = 'failed'
        job['message'] = '流程中断；敏感上下文未写入日志'
    finally:
        job['finishedAt'] = now_iso()
        with _job_guard:
            if _active_job is job:
                job['finished'] = True
        _job_lock.release()
        with _status_guard:
            global _status_cache
            _status_cache = None


PAGE = r'''<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="__CSRF__">
  <title>CYBER//LAB · Cloud Run 运维台</title>
  <style nonce="__NONCE__">
    :root{color-scheme:dark;--bg:#080d18;--panel:#111a2b;--line:#24334b;--text:#e8f0ff;--muted:#91a1bb;--cyan:#59e4d4;--blue:#7299ff;--warn:#f4c86a;--bad:#ff7886;--green:#72e0a0}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 80% -15%,#1b3050 0,transparent 45%),var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{max-width:1120px;margin:auto;padding:32px 22px 52px}.eyebrow{letter-spacing:.14em;color:var(--cyan);font:600 12px/1.3 ui-monospace,Menlo,monospace}.title{font-size:clamp(28px,5vw,44px);letter-spacing:-.04em;margin:10px 0 6px}.accent{color:var(--cyan)}.subtitle{color:var(--muted);margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.card{background:linear-gradient(145deg,#142038,#101827);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 12px 34px #0003}.card h2{font-size:14px;color:var(--muted);font-weight:600;margin:0 0 9px}.value{font-size:19px;font-weight:650;overflow-wrap:anywhere}.small{font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}.pill{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:99px;padding:4px 9px;font-size:12px}.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--muted)}.pill.good:before{background:var(--green);box-shadow:0 0 10px var(--green)}.pill.bad:before{background:var(--bad)}.pill.warn:before{background:var(--warn)}
    .section{margin-top:18px}.section h2{font-size:16px;margin:0 0 12px}.actions{display:flex;flex-wrap:wrap;gap:10px}.button{appearance:none;border:1px solid #345078;border-radius:10px;color:var(--text);background:#192742;padding:11px 16px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:.15s}.button:hover:not(:disabled){border-color:var(--cyan);transform:translateY(-1px)}.button:focus-visible{outline:3px solid #59e4d477;outline-offset:2px}.button.primary{color:#07151b;background:var(--cyan);border-color:var(--cyan)}.button.release{background:#263148;border-color:#657aa2}.button:disabled{opacity:.5;cursor:wait}.hint{color:var(--muted);font-size:13px;margin:12px 0 0}.terminal{min-height:220px;max-height:420px;overflow:auto;background:#060b13;border:1px solid var(--line);border-radius:12px;padding:14px;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.log{color:#c6d5ef}.log .time{color:#5d708e}.files{margin:0;padding-left:20px;color:#c4d1e8;font:12px/1.6 ui-monospace,Menlo,monospace}.footer{color:#687b98;font-size:12px;margin-top:24px}.external{color:var(--cyan);word-break:break-all}.banner{display:none;margin:16px 0;padding:12px 14px;border-radius:10px;border:1px solid #735d32;background:#291f10;color:#ffdc91}.banner.show{display:block}
    @media(max-width:760px){main{padding:22px 14px 36px}.grid{grid-template-columns:1fr}.actions{display:grid;grid-template-columns:1fr}.button{width:100%}.card{padding:16px}}
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">LOCAL CONTROL PLANE · 127.0.0.1</div>
    <h1 class="title">CYBER//LAB <span class="accent">OPS</span></h1>
    <p class="subtitle">Git 同步 · Cloud Run 发布 · Cloud SQL 状态</p>
    <div class="grid" aria-live="polite">
      <section class="card"><h2>Git 分支 / 提交</h2><div class="value" id="git-head">读取中…</div><div class="small" id="git-changes"></div></section>
      <section class="card"><h2>Google Cloud 项目</h2><div class="value" id="gcp-project">读取中…</div><div class="small" id="gcp-auth"></div></section>
      <section class="card"><h2>Cloud Run · us-central1</h2><div class="value" id="run-ready">读取中…</div><div class="small" id="run-revision"></div><div class="small" id="run-health">Cloud SQL 检查中…</div><a class="external" id="run-url" rel="noreferrer" target="_blank"></a></section>
    </div>
    <div class="banner" id="project-warning"></div>
    <section class="card section">
      <h2>发布操作</h2>
      <div class="actions">
        <button class="button" data-action="check">运行项目检查</button>
        <button class="button primary" data-action="build">检查并构建</button>
        <button class="button release" data-action="release">检查 → 构建 → Git 推送 → Cloud Run 部署</button>
      </div>
      <p class="hint">发布动作只会处理项目 Git 白名单中的变更；若存在已暂存改动、白名单外文件或 main 分支分叉，会停止且保留现场。API 密钥从 Cloud Run 已配置的 Secret Manager 引用读取，不在本机界面输入或显示。</p>
    </section>
    <section class="card section">
      <h2>工作区变更</h2><ul class="files" id="changed-files"><li>读取中…</li></ul>
    </section>
    <section class="card section">
      <h2>执行日志</h2><div class="terminal" id="logs" role="log" aria-live="polite">尚无操作。选择一项开始。</div>
    </section>
    <p class="footer">本机服务仅监听 127.0.0.1。关闭此窗口后，回到启动器终端按 Ctrl+C 停止工作台。自动刷新间隔 12 秒。</p>
  </main>
  <script nonce="__NONCE__">
    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? '');
    let busy = false;
    function setText(id, value) { $(id).textContent = esc(value); }
    function pill(label, kind) { return `${label} · ${kind}`; }
    async function refresh() {
      try {
        const response = await fetch('/api/status', {cache:'no-store'});
        if (!response.ok) throw new Error('状态读取失败');
        const payload = await response.json();
        const data = payload.status || {};
        setText('git-head', `${data.branch || '未知'} · ${data.commit || '未知'}`);
        setText('git-changes', `${data.changeCount || 0} 项工作区变更`);
        setText('gcp-project', data.project || '未设置本机默认项目');
        setText('gcp-auth', data.gcloudAuthenticated ? 'gcloud 已登录' : 'gcloud 未登录');
        setText('run-ready', data.service?.ready ? '服务就绪' : (data.service?.url ? '服务未就绪' : '尚无部署记录'));
        setText('run-revision', data.service?.revision || '等待 Cloud Run 服务');
        const database = data.health?.database || 'unknown';
        setText('run-health', database === 'ok' ? 'Cloud SQL cyber_lab 已连通' : (database === 'not-configured' ? 'Cloud SQL 尚未配置' : 'Cloud SQL 暂不可用'));
        const url = $('run-url');
        if (data.service?.url && /^https:\/\/[a-z0-9.-]+\.run\.app\/?$/i.test(data.service.url)) {
          url.href = data.service.url; url.textContent = data.service.url;
        } else { url.removeAttribute('href'); url.textContent = ''; }
        const warning = $('project-warning');
        if (data.project && data.project !== 'karas-513205') {
          warning.textContent = '本机 gcloud 默认项目与 CYBER//LAB 目标项目不同；发布命令仍固定使用 karas-513205。';
          warning.classList.add('show');
        } else warning.classList.remove('show');
        const list = $('changed-files'); list.replaceChildren();
        const changes = Array.isArray(data.changes) ? data.changes : [];
        if (!changes.length) {
          const item = document.createElement('li'); item.textContent = '无待提交变更'; list.append(item);
        } else {
          for (const change of changes) {
            const item = document.createElement('li'); item.textContent = `${change.status}  ${change.path}`; list.append(item);
          }
          if (data.changeCount > changes.length) {
            const item = document.createElement('li'); item.textContent = `另有 ${data.changeCount - changes.length} 项`; list.append(item);
          }
        }
        if (payload.job) renderJob(payload.job);
      } catch (error) {
        setText('gcp-auth', '状态读取失败');
      }
    }
    function renderJob(job) {
      busy = job.status === 'running';
      document.querySelectorAll('[data-action]').forEach((button) => button.disabled = busy);
      const terminal = $('logs'); terminal.replaceChildren();
      for (const entry of (job.logs || [])) {
        const row = document.createElement('div'); row.className = 'log';
        const time = document.createElement('span'); time.className = 'time'; time.textContent = `${entry.time}  `;
        const text = document.createElement('span'); text.textContent = entry.text;
        row.append(time, text); terminal.append(row);
      }
      if (!job.logs?.length) terminal.textContent = job.status === 'running' ? '操作已启动…' : '尚无日志';
      terminal.scrollTop = terminal.scrollHeight;
    }
    async function startAction(action) {
      if (busy) return;
      if (action === 'release' && !window.confirm('确认按顺序运行项目检查和构建，通过后提交中文 Git commit、推送 origin/main，再部署 Cloud Run cyber-lab？')) return;
      document.querySelectorAll('[data-action]').forEach((button) => button.disabled = true);
      try {
        const response = await fetch('/api/actions', {
          method:'POST',
          headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
          body:JSON.stringify({action})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '操作无法启动');
        busy = true;
        await refresh();
      } catch (error) {
        $('logs').textContent = esc(error.message || '操作无法启动');
        document.querySelectorAll('[data-action]').forEach((button) => button.disabled = false);
      }
    }
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => startAction(button.dataset.action)));
    refresh(); setInterval(refresh, 2500);
  </script>
</body>
</html>'''


def job_snapshot() -> dict | None:
    with _job_guard:
        if _active_job is None:
            return None
        return {
            'id': _active_job['id'],
            'action': _active_job['action'],
            'status': _active_job['status'],
            'message': _active_job.get('message', ''),
            'logs': list(_active_job['logs']),
            'startedAt': _active_job['startedAt'],
            'finishedAt': _active_job.get('finishedAt'),
        }


class WorkbenchServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'CyberLabOps/1.0'
    sys_version = ''

    def log_message(self, _format: str, *_args) -> None:
        # 不记录 URL、请求体、查询参数或本机浏览器数据。
        return

    def _host_valid(self) -> bool:
        return self.headers.get('Host', '') == f'127.0.0.1:{self.server.server_port}'

    def _send(self, status: int, payload: bytes, content_type: str = 'application/json; charset=utf-8', extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _host_error(self) -> bool:
        if self._host_valid() and self.client_address[0] == '127.0.0.1':
            return False
        self._json(403, {'error': '仅允许本机浏览器访问'})
        return True

    def do_GET(self) -> None:
        if self._host_error():
            return
        if self.path == '/':
            nonce = secrets.token_urlsafe(18)
            page = PAGE.replace('__NONCE__', nonce).replace('__CSRF__', _csrf_token).encode('utf-8')
            csp = (
                "default-src 'none'; "
                f"style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'; "
                "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
            )
            self._send(200, page, 'text/html; charset=utf-8', {
                'Content-Security-Policy': csp,
                'Set-Cookie': f'cyberlab_ops_csrf={_csrf_token}; Path=/; SameSite=Strict; HttpOnly',
            })
            return
        if self.path == '/api/status':
            self._json(200, {'status': get_status(), 'job': job_snapshot()})
            return
        self._json(404, {'error': '未找到'})

    def do_POST(self) -> None:
        if self._host_error():
            return
        expected_origin = f'http://127.0.0.1:{self.server.server_port}'
        if self.headers.get('Origin') != expected_origin:
            self._json(403, {'error': '请求来源校验失败'})
            return
        cookie = self.headers.get('Cookie', '')
        csrf_cookie = next((part.strip().split('=', 1)[1] for part in cookie.split(';') if part.strip().startswith('cyberlab_ops_csrf=')), '')
        csrf_header = self.headers.get('X-CSRF-Token', '')
        if not secrets.compare_digest(csrf_cookie, _csrf_token) or not secrets.compare_digest(csrf_header, _csrf_token):
            self._json(403, {'error': '安全令牌校验失败，请刷新页面'})
            return
        if self.path != '/api/actions':
            self._json(404, {'error': '未找到'})
            return
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            self._json(400, {'error': '请求格式无效'})
            return
        if size < 1 or size > 4096:
            self._json(413, {'error': '请求大小无效'})
            return
        try:
            data = json.loads(self.rfile.read(size).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {'error': '请求格式无效'})
            return
        action = data.get('action') if isinstance(data, dict) else None
        if action not in {'check', 'build', 'release'}:
            self._json(400, {'error': '不支持的操作'})
            return
        if not _job_lock.acquire(blocking=False):
            self._json(409, {'error': '当前已有任务运行'})
            return
        global _active_job
        job = {
            'id': secrets.token_hex(12),
            'action': action,
            'status': 'running',
            'startedAt': now_iso(),
            'logs': collections.deque(maxlen=MAX_LOG_LINES),
        }
        with _job_guard:
            _active_job = job
        append_log(job, {'check': '开始项目检查', 'build': '开始检查与构建', 'release': '开始检查、构建、Git 推送与 Cloud Run 发布'}[action])
        thread = threading.Thread(target=worker, args=(action, job), daemon=True)
        thread.start()
        self._json(202, {'accepted': True, 'jobId': job['id']})


def run_server() -> None:
    if not ROOT.joinpath('package.json').is_file():
        raise SystemExit('请将此工作台放在赛博实验室项目根目录运行。')
    if not command_available('git'):
        print('未检测到 git CLI；检查与构建仍可运行，发布操作需要 git。')

    server = None
    last_error = None
    for port in range(8585, 8596):
        try:
            server = WorkbenchServer(('127.0.0.1', port), Handler)
            break
        except OSError as exc:
            last_error = exc
    if server is None:
        raise SystemExit(f'无法绑定本机工作台端口：{type(last_error).__name__ if last_error else "未知错误"}')

    url = f'http://127.0.0.1:{server.server_port}/'
    print('CYBER//LAB Cloud Run 本机运维台已启动。')
    print(f'访问地址：{url}')
    print('停止服务：回到此终端按 Ctrl+C。')
    try:
        webbrowser.open(url, new=1, autoraise=True)
    except Exception:
        pass
    try:
        server.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print('\n运维工作台已停止。')
    finally:
        server.server_close()


if __name__ == '__main__':
    run_server()
