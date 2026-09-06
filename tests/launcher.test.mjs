import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

async function fixture(mode, port = '4189') {
  const root = await mkdtemp(join(tmpdir(), 'event console launcher '));
  const app = join(root, 'relocated console');
  const bin = join(root, 'bin');
  const calls = join(root, 'calls');
  const ready = join(root, 'ready');
  await mkdir(join(app, 'launcher'), { recursive: true });
  await mkdir(join(app, 'node_modules'));
  await mkdir(bin);
  await copyFile(new URL('../launcher/launch.sh', import.meta.url), join(app, 'launcher/launch.sh'));
  const scripts = {
    curl: `#!/bin/sh
if [ "$EVENT_TEST_MODE" = vacant ]; then
  [ -f "$EVENT_TEST_READY" ] || exit 7
  echo '<title>Event Console — launcher</title>'
elif [ "$EVENT_TEST_MODE" = same-title ]; then
  echo '<title>Event Console — stale copy</title>'
else
  echo '<title>Another app</title>'
fi
`,
    npm: `#!/bin/sh
printf "npm %s\\n" "$*" >> "$EVENT_TEST_CALLS"
if [ "$1 $2" = 'run build' ]; then exit 0; fi
if [ "$1" = start ]; then
  : > "$EVENT_TEST_READY"
  while [ -d "$EVENT_TEST_ROOT" ]; do sleep 0.05; done
  exit 0
fi
echo "Unexpected npm call: $*" >&2
exit 99
`,
    uname: '#!/bin/sh\necho Darwin\n',
    open: '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" >> "$EVENT_TEST_CALLS"\n',
    defaults: '#!/bin/sh\necho "POLICY WRITE" >> "$EVENT_TEST_CALLS"\nexit 99\n',
  };
  for (const [name, content] of Object.entries(scripts)) await writeFile(join(bin, name), content, { mode: 0o755 });
  const result = spawnSync('bash', [join(app, 'launcher/launch.sh')], {
    cwd: tmpdir(), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EVENT_TEST_MODE: mode,
      EVENT_TEST_CALLS: calls, EVENT_TEST_READY: ready, EVENT_TEST_ROOT: root,
      XDG_STATE_HOME: join(root, 'state'), EVENT_CONSOLE_PORT: port,
      EVENT_CONSOLE_CHROME_APP: join(root, 'No Chrome.app') },
  });
  const log = await readFile(calls, 'utf8').catch(() => '');
  await rm(root, { recursive: true, force: true });
  return { ...result, log, app };
}

test('relocated launcher starts from a path with spaces and opens matching origins without changing policies', async () => {
  const result = await fixture('vacant');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.log.includes(result.app));
  assert.ok(result.log.includes('npm run build'));
  assert.ok(result.log.includes('npm start -- --port 4189'));
  assert.ok(result.log.includes('http://127.0.0.1:4189/control.html'));
  assert.ok(result.log.includes('http://127.0.0.1:4189/display.html'));
  assert.ok(!result.log.includes('POLICY WRITE'));
});

test('a foreign server occupying the port is not reused or opened', async () => {
  const result = await fixture('foreign');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another application/);
  assert.equal(result.log, '');
});

test('an older Event Console occupying the port is also rejected instead of silently reused', async () => {
  const result = await fixture('same-title');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Another application/);
  assert.equal(result.log, '');
});

test('invalid ports fail before opening a browser', async () => {
  for (const port of ['abc', '0', '65536']) {
    const result = await fixture('reuse', port);
    assert.equal(result.status, 1, port);
    assert.equal(result.log, '');
  }
});
