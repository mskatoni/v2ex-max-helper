'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('container uses supported Node, reproducible installs, and supervised children', () => {
  const dockerfile = read('Dockerfile');
  const entrypoint = read('scripts/entrypoint.sh');
  const compose = read('docker-compose.yml');
  assert.match(dockerfile, /^FROM node:24-bookworm-slim$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /^\s+CMD wget /m);
  assert.doesNotMatch(dockerfile, /\bCMD-SHELL\b/);
  assert.match(dockerfile, /\$\{PORT:-8080\}\/health/);
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
  assert.match(entrypoint, /^exec node reader\/bot\.js$/m);
  assert.doesNotMatch(entrypoint, /node server\.js|BOT_PID|SERVER_PID/);
  assert.doesNotMatch(dockerfile, /^COPY server\.js/m);
  assert.match(compose, /^\s+stop_grace_period: 45s$/m);
});

test('dependency manifests are locked and require Node 24', () => {
  for (const dir of ['reader', 'checkin']) {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    const lock = JSON.parse(read(`${dir}/package-lock.json`));
    assert.equal(pkg.engines.node, '>=24');
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages[''].version, pkg.version);
  }
  const reader = JSON.parse(read('reader/package.json'));
  assert.equal(reader.dependencies.playwright.startsWith('^'), false);
  assert.equal(reader.dependencies['sql.js'].startsWith('^'), false);
});

test('publishing waits for tests and beta cannot overwrite latest', () => {
  const workflow = read('.github/workflows/docker-publish.yml');
  assert.match(workflow, /^\s+test:$/m);
  assert.match(workflow, /^\s+needs: test$/m);
  assert.match(workflow, /^\s+pull_request:$/m);
  assert.match(workflow, /^\s+if: github\.event_name != 'pull_request'$/m);
  assert.match(workflow, /value=beta[^\n]+mskatoni-patch-beta/);
  assert.match(workflow, /value=latest[^\n]+refs\/heads\/main/);
  assert.doesNotMatch(workflow, /value=latest[^\n]+refs\/tags/);
  assert.match(workflow, /^concurrency:$/m);
  assert.doesNotMatch(workflow, /uses: [^\s]+@v\d+/);
  assert.doesNotMatch(workflow, /^\s+type=raw,value=latest\s*$/m);
  assert.match(read('render.yaml'), /autoDeployTrigger: checksPass/);
});

test('runtime identity and scheduler state are excluded from Git and Docker contexts', () => {
  for (const file of ['.gitignore', '.dockerignore']) {
    const source = read(file);
    assert.match(source, /^profile_identity\*\.json$/m);
    assert.match(source, /^profile_schedule_state\.json$/m);
    assert.match(source, /^\.locks\/$/m);
  }
});

test('installer documents the bot-only path instead of recreating timers', () => {
  const installer = read('scripts/install.sh');
  const systemdInstaller = read('scripts/install-systemd.sh');
  assert.match(installer, /install-systemd\.sh --bot-only/);
  assert.doesNotMatch(installer, /install-systemd\.sh --bot(?:["')\s]|$)/m);
  assert.match(systemdInstaller, /Requires=%s\.service\\nAfter=%s\.service/);
  assert.match(systemdInstaller, /READER_UNIT_DEPS/);
  assert.doesNotMatch(installer, /\$INSTALL (?:xvfb|xorg-x11-server-Xvfb)/);
  assert.match(systemdInstaller, /HEADLESS=false/);
  assert.match(systemdInstaller, /\[y\/N\]/);
  assert.match(systemdInstaller, /systemd-analyze calendar "\$T_CHECKIN"/);
  assert.match(systemdInstaller, /systemd-analyze calendar "\$T_PING"/);
  assert.match(systemdInstaller, /systemd-analyze calendar "\$T_READER"/);
  assert.match(systemdInstaller, /systemctl restart "\$\{UNIT_BOT\}\.service"/);
  assert.match(systemdInstaller, /systemctl is-active --quiet "\$\{UNIT_BOT\}\.service"/);
  assert.match(installer, /V2EX_PROFILE 不能使用跨平台保留名称/);
  assert.match(systemdInstaller, /profile 不能使用跨平台保留名称/);
});

test('native updater cannot claim success without loading new code and restarting the bot', () => {
  const installer = read('scripts/install.sh');
  assert.match(installer, /for pkg in curl unzip git rsync/);
  assert.match(installer, /sync_zip_branch "\$PROJ_DIR"/);
  assert.match(installer, /install-systemd\.sh" "\$\{BOT_ARGS\[@\]\}"/);
  assert.doesNotMatch(installer, /systemctl try-restart/);
  assert.doesNotMatch(installer, /curl[^\n|]*\|\s*bash/);
  assert.doesNotMatch(installer, /rm -rf "\$PROJ_DIR"/);
  assert.match(installer, /目标路径已存在但不是已识别的项目，拒绝删除/);
  assert.match(installer, /rsync -a --delete-delay/);
  assert.match(installer, /validate_project_path/);
  assert.match(installer, /拒绝对系统目录或用户家目录操作/);
  assert.match(installer, /chromium\.launch\(\{ headless: true/);
});
