// Path resolver and fs API semantics. Set BNCM_TEST_TMP to choose where the temp profile goes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP_ROOT = process.env.BNCM_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DP = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-fsapi-')));
const OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'bncm-outside-')));
process.env.BETTERNCM_PROFILE = DP;

const fsapi = await import('../src/fsapi.mjs');
const { splitCommandLine, filterExtensions } = await import('../src/macos.mjs');

function makeZip(file, entries) {
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, json, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, body in entries.items():
        z.writestr(name, body)
`, file, JSON.stringify(entries)]);
}

before(() => {
  fs.mkdirSync(path.join(DP, 'plugins_dev', 'Foo'), { recursive: true });
  fs.writeFileSync(path.join(DP, 'plugins_dev', 'Foo', 'manifest.json'), '{}');
});

after(() => {
  fs.rmSync(DP, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

test('resolve: datapath-relative paths are joined without normalizing', () => {
  assert.equal(fsapi.resolve('./plugins_runtime'), DP + '/./plugins_runtime');
  assert.equal(fsapi.resolve('plugins/x.plugin'), DP + '/plugins/x.plugin');
  assert.equal(fsapi.resolve(''), DP + '/');
});

test('resolve: leading-slash paths whose first segment is not at / stay datapath-relative', () => {
  assert.equal(fsapi.resolve('/plugins/X.plugin'), DP + '/plugins/X.plugin');
  assert.equal(fsapi.resolve('/__TEST_SUCCEEDED__.txt'), DP + '/__TEST_SUCCEEDED__.txt');
  assert.equal(fsapi.resolve('\\plugins\\Foo.plugin'), DP + '/plugins/Foo.plugin');
});

test('resolve: real absolute paths and datapath paths pass through', () => {
  assert.equal(fsapi.resolve('/Users/someone/x'), '/Users/someone/x');
  assert.equal(fsapi.resolve('/Applications/NeteaseMusic.app'), '/Applications/NeteaseMusic.app');
  assert.equal(fsapi.resolve(DP + '/plugins'), DP + '/plugins');
  assert.equal(fsapi.resolve(DP.replace(/\//g, '\\') + '\\.\\plugins_dev'), DP + '/./plugins_dev');
});

test('resolve: Windows drive paths are rejected', () => {
  assert.throws(() => fsapi.resolve('C:\\x'), /Windows path not supported/);
  assert.throws(() => fsapi.resolve('d:/music'), /Windows path not supported/);
});

test('readDir keeps the caller spelling so "./plugins_dev" survives', () => {
  const list = fsapi.readDir('./plugins_dev');
  assert.deepEqual(list, [DP + '/./plugins_dev/Foo']);
  assert.ok(list[0].includes('./plugins_dev'));
  assert.throws(() => fsapi.readDir('./does_not_exist'));
});

test('readFileText returns "" for missing files; exists() is false for Windows paths', () => {
  assert.equal(fsapi.readFileText('./nope.txt'), '');
  assert.equal(fsapi.exists('./nope.txt'), false);
  assert.equal(fsapi.exists('C:\\Windows'), false);
  assert.equal(fsapi.exists('./plugins_dev'), true);
});

test('writeFileText creates parents, readFileText reads UTF-8 back', () => {
  assert.equal(fsapi.writeFileText('/__TEST_SUCCEEDED__.txt', 'ok'), true);
  assert.equal(fs.readFileSync(path.join(DP, '__TEST_SUCCEEDED__.txt'), 'utf8'), 'ok');
  assert.equal(fsapi.writeFileText('./a/b/c.txt', '中文 ✓'), true);
  assert.equal(fsapi.readFileText('a/b/c.txt'), '中文 ✓');
});

test('getProperties: parent dir in path, FILETIME-epoch lastModified, dirs have size 0', () => {
  fsapi.writeFileText('./props/file.json', '12345');
  const p = fsapi.getProperties('./props/file.json');
  assert.equal(p.name, 'file.json');
  assert.equal(p.path, DP + '/./props');
  assert.equal(p.size, 5);
  assert.equal(p.type, 'file');
  assert.equal(p.extension, '.json');
  assert.equal(p.hidden, false);
  assert.equal(p.system, false);
  const mtime = fs.statSync(path.join(DP, 'props', 'file.json')).mtimeMs;
  assert.ok(Math.abs(p.lastModified - fsapi.FILETIME_OFFSET_MS - mtime) < 2);
  // what PluginMarket's remover.js does with it
  assert.ok(Math.abs(new Date(p.lastModified - 11644473600000).getTime() - mtime) < 2);
  const d = fsapi.getProperties('./props');
  assert.equal(d.type, 'directory');
  assert.equal(d.size, 0);
  assert.throws(() => fsapi.getProperties('./props/missing'));
});

test('readDirWithDetails lists entries with types', () => {
  fsapi.writeFileText('./details/.hidden', 'x');
  fsapi.mkdir('./details/sub');
  const items = fsapi.readDirWithDetails('./details').sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(items.map((i) => [i.name, i.type, i.hidden]), [['.hidden', 'file', true], ['sub', 'directory', false]]);
  assert.equal(items[0].path, DP + '/./details/.hidden');
});

test('rename and remove inside the data dir', () => {
  fsapi.writeFileText('./mv/a.txt', 'a');
  assert.equal(fsapi.rename('./mv/a.txt', './mv/b.txt'), true);
  assert.equal(fsapi.exists('./mv/b.txt'), true);
  assert.equal(fsapi.remove('./mv'), true);
  assert.equal(fsapi.exists('./mv'), false);
  assert.equal(fsapi.remove('./never-existed'), true);
});

test('mutations outside the data dir are refused unless allowed', () => {
  const victim = path.join(OUTSIDE, 'keep.txt');
  fs.writeFileSync(victim, 'keep');
  assert.throws(() => fsapi.remove(victim), /outside the BetterNCM data directory/);
  assert.throws(() => fsapi.writeFileText(path.join(OUTSIDE, 'new.txt'), 'x'), /outside/);
  assert.throws(() => fsapi.rename('./props/file.json', path.join(OUTSIDE, 'stolen.json')), /outside/);
  assert.throws(() => fsapi.remove('./props/../../' + path.basename(OUTSIDE)), /outside/);
  assert.throws(() => fsapi.remove(''), /data directory itself/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  // reads are allowed anywhere (BGEnhanced reads user-picked files)
  assert.equal(fsapi.readFileText(victim), 'keep');

  fs.writeFileSync(path.join(DP, 'config.json'), JSON.stringify({ 'mac.allowFsOutsideData': 'true' }));
  try {
    assert.equal(fsapi.remove(victim), true);
    assert.equal(fs.existsSync(victim), false);
  } finally {
    fs.rmSync(path.join(DP, 'config.json'));
  }
});

test('symlinks out of the data dir do not bypass the guard', () => {
  fs.symlinkSync(OUTSIDE, path.join(DP, 'escape'));
  fs.writeFileSync(path.join(OUTSIDE, 'f.txt'), 'f');
  assert.throws(() => fsapi.remove('./escape/f.txt'), /outside/);
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'f.txt')), true);
});

test("'..' after a symlink is resolved physically, not as text", () => {
  const code = fs.mkdtempSync(path.join(OUTSIDE, 'code-'));
  fs.mkdirSync(path.join(code, 'foo'));
  fs.writeFileSync(path.join(code, 'victim'), 'v');
  fs.symlinkSync(path.join(code, 'foo'), path.join(DP, 'plugins_dev', 'linked'));
  assert.throws(() => fsapi.writeFileText('plugins_dev/linked/x.txt', 'x'), /outside/);
  assert.throws(() => fsapi.writeFileText('plugins_dev/linked/../ESCAPED.txt', 'x'), /outside/);
  assert.throws(() => fsapi.mkdir('plugins_dev/linked/../ESCDIR'), /outside/);
  assert.throws(() => fsapi.remove('plugins_dev/linked/../victim'), /outside/);
  assert.throws(() => fsapi.rename('plugins_dev/Foo/manifest.json', 'plugins_dev/linked/../stolen.json'), /outside/);
  assert.deepEqual(fs.readdirSync(code).sort(), ['foo', 'victim']);
  // a dangling link is followed like the kernel would
  fs.symlinkSync(path.join(OUTSIDE, 'not-yet'), path.join(DP, 'dangling'));
  assert.throws(() => fsapi.writeFileText('./dangling', 'x'), /outside/);
  assert.equal(fs.existsSync(path.join(OUTSIDE, 'not-yet')), false);
  // removing the link itself is fine and leaves the target alone
  assert.equal(fsapi.remove('plugins_dev/linked'), true);
  assert.equal(fs.existsSync(path.join(code, 'foo')), true);
  fs.rmSync(path.join(DP, 'dangling'));
});

test('config.json, run/ and the NCM app are off limits even with allowFsOutsideData', async () => {
  fs.writeFileSync(path.join(DP, 'config.json'), JSON.stringify({ 'mac.allowFsOutsideData': 'true' }));
  try {
    assert.throws(() => fsapi.writeFileText('./config.json', '{}'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.writeFileText('./config.json.1.tmp', '{}'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.remove('./config.json'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.rename('./props/file.json', './config.json'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.writeFileText('./run/state.json', '{}'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.writeFileText('./Config.JSON', '{}'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.writeFileText('./RUN/state.json', '{}'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.mkdir('/applications/neteasemusic.app/Contents/x'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.mkdir('/Applications/NeteaseMusic.app/Contents/x'), (e) => e.code === 'EBNCMDENIED');
    assert.throws(() => fsapi.writeFileText('/Applications/NeteaseMusic.app/Contents/MacOS/../Resources/x', ''), (e) => e.code === 'EBNCMDENIED');
    const z = path.join(DP, 'cfg.zip');
    makeZip(z, { 'config.json': '{"mac.allowExec":"true"}' });
    await assert.rejects(fsapi.unzip('./cfg.zip', './'), (e) => e.code === 'EBNCMDENIED');
    assert.equal(JSON.parse(fs.readFileSync(path.join(DP, 'config.json'), 'utf8'))['mac.allowExec'], undefined);
  } finally {
    fs.rmSync(path.join(DP, 'config.json'));
  }
});

test('unzip treats warnings-only (exit 1, backslash separators) as success', async () => {
  const z = path.join(DP, 'bs.zip');
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for name, body in (('manifest.json', '{}'), ('sub\\\\a.js', 'A')):
        i = zipfile.ZipInfo(name); i.create_system = 0
        z.writestr(i, body)
`, z]);
  assert.equal(await fsapi.unzip('./bs.zip', './bsout'), 0);
  assert.equal(fsapi.readFileText('./bsout/sub/a.js'), 'A');
});

test('unzip removes symlink members that zipinfo does not flag', async () => {
  const z = path.join(DP, 'vms.zip');
  execFileSync('/usr/bin/python3', ['-I', '-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('ok.txt', 'x')
    i = zipfile.ZipInfo('esc'); i.create_system = 2; i.external_attr = 0o120777 << 16
    z.writestr(i, 'sub/../../outside')
`, z]);
  assert.notEqual(await fsapi.unzip('./vms.zip', './vmsout'), 0);
  let st = null;
  try { st = fs.lstatSync(path.join(DP, 'vmsout', 'esc')); } catch { /* removed */ }
  assert.ok(!st || !st.isSymbolicLink());
});

test('unzip returns 0, and refuses traversal archives with a non-zero code', async () => {
  const good = path.join(DP, 'good.zip');
  makeZip(good, { 'manifest.json': '{}', 'dir/a.txt': 'A' });
  assert.equal(await fsapi.unzip('./good.zip', './out'), 0);
  assert.equal(fsapi.readFileText('./out/dir/a.txt'), 'A');

  const bad = path.join(DP, 'bad.zip');
  makeZip(bad, { 'ok.txt': 'x', '../escaped.txt': 'evil' });
  assert.notEqual(await fsapi.unzip('./bad.zip', './out2'), 0);
  assert.equal(fs.existsSync(path.join(DP, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(DP, 'out2', 'ok.txt')), false);
});

test('watchDirectory reports (dir, relative filename) and can be disposed', async () => {
  fsapi.mkdir('./plugins_dev/W');
  const events = [];
  const dispose = fsapi.watchDirectory('./plugins_dev/W', (dir, rel) => events.push([dir, rel]));
  await new Promise((r) => setTimeout(r, 300));
  fs.mkdirSync(path.join(DP, 'plugins_dev', 'W', 'sub'));
  fs.writeFileSync(path.join(DP, 'plugins_dev', 'W', 'sub', 'main.js'), 'x');
  const deadline = Date.now() + 5000;
  while (!events.some(([, rel]) => rel === 'sub/main.js') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  dispose();
  const hit = events.find(([, rel]) => rel === 'sub/main.js');
  assert.ok(hit, 'expected an event for sub/main.js, got ' + JSON.stringify(events));
  assert.equal(hit[0], DP + '/./plugins_dev/W');
});

test('getLibraries and getDisks have v2 shapes', () => {
  for (const l of fsapi.getLibraries()) {
    assert.ok(['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].includes(l.name));
    assert.ok(path.isAbsolute(l.path));
  }
  const disks = fsapi.getDisks();
  assert.ok(disks.length > 0);
  for (const d of disks) {
    assert.ok(d.disk.startsWith('/Volumes/'));
    assert.equal(typeof d.size, 'number');
    assert.ok(d.used <= d.size);
  }
});

test('mimeOf covers v2 types plus web media', () => {
  assert.equal(fsapi.mimeOf('a.PNG'), 'image/png');
  assert.equal(fsapi.mimeOf('a.mp3'), 'audio/mpeg');
  assert.equal(fsapi.mimeOf('a.flac'), 'audio/mpeg');
  assert.equal(fsapi.mimeOf('x/y.webp'), 'image/webp');
  assert.equal(fsapi.mimeOf('v.mp4'), 'video/mp4');
  assert.equal(fsapi.mimeOf('f.woff2'), 'font/woff2');
  assert.match(fsapi.mimeOf('s.svg'), /^image\/svg\+xml/);
  assert.equal(fsapi.mimeOf('noext'), 'application/octet-stream');
});

test('macos: command lines split like CommandLineToArgvW', () => {
  assert.deepEqual(splitCommandLine('explorer "\\Users\\me\\Application Support\\x"'), ['explorer', '\\Users\\me\\Application Support\\x']);
  assert.deepEqual(splitCommandLine('https://github.com/a/b'), ['https://github.com/a/b']);
  assert.deepEqual(splitCommandLine('  a   b\t"c d" e"f g"h '), ['a', 'b', 'c d', 'ef gh']);
  assert.deepEqual(splitCommandLine('x "a\\"b" \\\\"q r"'), ['x', 'a"b', '\\q r']);
  assert.deepEqual(splitCommandLine('""'), ['']);
});

test('macos: file dialog filters become extension lists', () => {
  assert.deepEqual(filterExtensions('.webp .png .jpg .jpeg .bmp .gif\0'), ['webp', 'png', 'jpg', 'jpeg', 'bmp', 'gif']);
  assert.deepEqual(filterExtensions('.mp4, .webm\0'), ['mp4', 'webm']);
  assert.deepEqual(filterExtensions('Images (*.png;*.JPG)\0*.png;*.JPG\0'), ['png', 'jpg']);
  assert.deepEqual(filterExtensions('All files\0*.*\0'), []);
  assert.deepEqual(filterExtensions(''), []);
});
