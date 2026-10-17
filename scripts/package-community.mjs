// Explicit public early-access packaging. This path never reads a signing
// identity, local signing configuration, Google client file, or user data.
import { packager } from '@electron/packager';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This early-access package is validated for macOS Apple Silicon only.');
const args = process.argv.slice(2), preview = args.includes('--preview');
const pathsArgument = args.filter(value => value !== '--preview');
if (pathsArgument.length > 1) throw new Error('Usage: node scripts/package-community.mjs [output-directory] [--preview]');
const output = resolve(pathsArgument[0] || join(root, 'out/community-release'));
const stage = join(output, 'stage');
const packages = join(output, 'application');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error('Build from a reviewed Git checkout.');
const sourceChanges = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'src', 'apps/console', 'desktop', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/legal'],
  { cwd: root, encoding: 'utf8' }).trim();
if (sourceChanges && !preview) throw new Error('Commit the reviewed runtime and legal inputs before building a public release. Use --preview only for unpublished validation.');
// Do not forward OAuth, signing or VITE_* values from the operator shell.
const buildEnv = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: homedir(), TMPDIR: tmpdir(), LC_ALL: 'C' };
for (const args of [['run', 'console:build'], ['run', 'typecheck'], ['run', 'console:typecheck'], ['run', 'check:locales']])
  execFileSync('npm', args, { cwd: root, env: buildEnv, stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'scripts/build-console.mjs')], { cwd: root, env: buildEnv, stdio: 'inherit' });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const allowedDesktop = new Set(['main.cjs', 'sampling.cjs', 'chrome-collector.cjs', 'browser-extract.cjs',
  'browser-platforms.cjs', 'capture-artifact.cjs', 'connection-vault.cjs', 'egress-check.cjs', 'locales', 'assets']);
const legalInventory = JSON.parse(readFileSync(join(root, 'docs/legal/dependency-licenses.json'), 'utf8'));
const noticeFiles = new Map();
for (const dependency of legalInventory.packages) {
  for (const file of [...(dependency.noticeFiles || []), ...(dependency.supplementFiles || [])]) {
    if (!file.path.startsWith('docs/legal/licenses/') || file.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new Error('Invalid preserved legal inventory entry.');
    noticeFiles.set(file.path, file);
  }
}
// This exact inventory exception preserves upstream attribution collateral.
// Owned runtime maps and every map outside the reviewed legal tree stay excluded.
const legalSourceMaps = new Set([...noticeFiles.keys()].filter(path => path.endsWith('.map')).map(path => join(root, path)));
function copy(source, target) {
  cpSync(source, target, { recursive: true, filter: p => (!p.endsWith('.map') || legalSourceMaps.has(p)) && !/\.(?:log|db|sqlite|enc|pem|key|p12|pfx)$|(?:^|\/)\.DS_Store$/.test(p) });
}
for (const directory of ['dist-node', 'dist/console']) copy(join(root, directory), join(stage, directory));
mkdirSync(join(stage, 'desktop'));
for (const name of allowedDesktop) copy(join(root, 'desktop', name), join(stage, 'desktop', name));
mkdirSync(join(stage, 'node_modules'));
const dependencies = {};
for (const name of ['re2js', 'zod', 'playwright-core']) {
  dependencies[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  copy(join(root, 'node_modules', name), join(stage, 'node_modules', name));
}
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'getaudit', productName: 'getaudit',
  version, type: 'module', main: 'desktop/main.cjs', license: 'MIT', author: 'getaudit contributors',
  description: 'An integrated SEO and GEO research workspace. Community early access.', dependencies }, null, 2) + '\n');
const releaseInfo = { product: 'getaudit', version, channel: 'community-early-access', platform: 'darwin', arch: 'arm64',
  minimumMacOS: '13.0', bundleId: 'org.getaudit.community', dataDirectoryName: 'getaudit Community',
  signing: 'ad-hoc', notarized: false, googleSignIn: 'not-configured', ga4: 'testing', bingWebmaster: 'planned',
  source: `https://github.com/maxuod/getaudit/tree/${sourceRevision}`, sourceRevision,
  sourceState: sourceChanges ? 'uncommitted-preview' : 'clean-reviewed-inputs',
  includedBrowsers: ['Electron embedded Chromium'],
  additionalBrowserDownloads: false, googleChromeRequiredForGeo: true };
const legal = join(stage, 'LEGAL');
mkdirSync(legal);
copy(join(root, 'LICENSE'), join(legal, 'LICENSE'));
copy(join(root, 'THIRD_PARTY_NOTICES.md'), join(legal, 'SOURCE-THIRD-PARTY-NOTICES.md'));
copy(join(root, 'docs/legal'), join(legal, 'source-dependency-notices'));
const preservedLegalMaps = new Set();
for (const file of noticeFiles.values()) {
  const target = join(legal, 'source-dependency-notices', file.path.slice('docs/legal/'.length));
  if (!existsSync(target) || createHash('sha256').update(readFileSync(target)).digest('hex') !== file.sha256 || lstatSync(target).size !== file.bytes)
    throw new Error('Preserved legal inventory mismatch: ' + file.path);
  if (target.endsWith('.map')) preservedLegalMaps.add(target);
}
releaseInfo.preservedSourceNoticeFiles = noticeFiles.size;
for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
  const source = join(root, 'node_modules/electron/dist', name);
  if (!existsSync(source)) throw new Error('Exact Electron runtime legal notices are required. Run the locked Electron install first.');
  copy(source, join(legal, name === 'LICENSE' ? 'ELECTRON-LICENSE' : name));
}
writeFileSync(join(legal, 'RUNTIME-NOTICES.md'), `# Runtime notices\n\nThis early-access binary includes Electron ${JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'))).version}, its embedded Chromium and Node.js runtime, and the JavaScript dependencies listed in package.json. Electron's exact LICENSE and LICENSES.chromium.html are included unchanged beside this file. They contain the bundled native runtime notices, including applicable source availability information.\n\nElectron source and release: https://github.com/electron/electron/releases/tag/v${JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'))).version}\nChromium source: https://chromium.googlesource.com/chromium/src/\nNode.js source: https://github.com/nodejs/node\nProject source: ${releaseInfo.source}\n\nThe application sources are MIT licensed. Runtime dependencies preserve their own licenses and notices. The complete locked source dependency notices are under source-dependency-notices/. The preserved SOURCE-THIRD-PARTY-NOTICES.md uses source-repository-relative links: its docs/legal/ paths map to source-dependency-notices/ in this package, and its LICENSE link maps to the LICENSE beside this file. Playwright's LICENSE, NOTICE, ThirdPartyNotices.txt and bundled notices stay in node_modules/playwright-core/. No separate Playwright browser, native add-on or external helper binary is included. Installed Google Chrome is required separately for GEO browser scans and is not included in this package.\n\nThis is an ad-hoc signed, unnotarized community early-access build. It does not include an app-owner Google OAuth client or user connection data.\n`);
writeFileSync(join(stage, 'EARLY-ACCESS.md'), `# getaudit community early access\n\nmacOS 13 or later, Apple Silicon only. This app is ad-hoc signed and is not notarized or verified by Apple. macOS may block a downloaded copy; see Apple's guidance before deciding whether to open software from an unidentified developer: https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac\n\nThe community build stores new local data separately under the getaudit Community application-data directory. It does not import production app connections. Ad-hoc builds do not guarantee encrypted connection continuity across updates: back up local evidence before upgrading, and reconnect services if macOS denies access.\n\nGoogle sign-in and GA4 are in testing. No app-owner Google OAuth client is included in this build; the public Google connection is not ready for ordinary users. Bing Webmaster Tools is planned. GEO scans require a separately installed Google Chrome browser, platform availability and any relevant configuration or platform login. Third-party model or data charges, if you explicitly configure and authorize them, remain separate.\n\n# getaudit 社区预览版\n\n仅支持 Apple Silicon Mac，要求 macOS 13 或更高版本。此版本采用临时签名，未经 Apple 公证。系统可能阻止下载的应用启动；请先阅读上述 Apple 官方说明，再决定是否打开来源未经验证的软件。\n\n社区版使用独立的 getaudit Community 数据目录，不导入正式应用的连接。临时签名不能保证后续升级仍可读取系统加密的连接；升级前请备份本地研究记录，系统拒绝访问时需要重新连接服务。\n\nGoogle 登录与 GA4 仍在测试。本包未包含应用方的 Google OAuth 客户端，普通用户的 Google 一键连接尚未就绪。Bing Webmaster Tools 尚在规划。GEO 浏览器扫描需要另外安装 Google Chrome，并完成相关配置；各平台仍可能要求登录或限制访问。由用户明确配置和授权的第三方模型或数据费用另计。\n`);
const payloadFiles = [];
function fingerprint(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(path);
    else payloadFiles.push({ path: path.slice(stage.length + 1), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  }
}
fingerprint(stage);
releaseInfo.payloadSha256 = createHash('sha256').update(JSON.stringify(payloadFiles)).digest('hex');
writeFileSync(join(stage, 'payload-manifest.json'), JSON.stringify({ algorithm: 'sha256', files: payloadFiles }, null, 2) + '\n');
writeFileSync(join(stage, 'release-info.json'), JSON.stringify(releaseInfo, null, 2) + '\n');
const disallowed = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) { disallowed.push(path); continue; }
    if (stat.isDirectory()) inspect(path);
    else if (/^\.env|google-oauth-client\.json$|\.(?:db|sqlite|enc|log|pem|key|p12|pfx)$|\.db-/.test(entry.name) || (entry.name.endsWith('.map') && !preservedLegalMaps.has(path))) disallowed.push(path);
    else if (stat.size < 25_000_000 && /\.(?:js|cjs|mjs|json|html|css|md|txt|map)$/.test(entry.name)) {
      const contents = readFileSync(path, 'utf8');
      if (/(?:\/Users\/[^/\s"'<>]+\/|\/Volumes\/[^/\n]+\/Developer\/|AIza[\w-]{30,}|GOCSPX-[\w-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(contents)) disallowed.push(path);
    }
  }
}
inspect(stage);
if (disallowed.length) throw new Error('Private or unreviewed artifacts are forbidden in the public stage: ' + disallowed.map(p => p.slice(stage.length + 1)).join(', '));
const paths = await packager({ dir: stage, name: 'getaudit', appBundleId: releaseInfo.bundleId,
  icon: join(root, 'desktop/assets/geo.icns'), appVersion: version, platform: 'darwin', arch: 'arm64',
  electronVersion: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'))).version,
  out: packages, overwrite: true, asar: true, prune: false, osxSign: false, osxNotarize: false,
  appCategoryType: 'public.app-category.business', darwinDarkModeSupport: false });
if (paths.length !== 1) throw new Error('Expected exactly one macOS arm64 application.');
const app = join(paths[0], 'getaudit.app');
// Remove inherited quarantine/provenance metadata from this new output only.
// User apps, source files and dependency caches are never altered.
execFileSync('/usr/bin/xattr', ['-cr', app], { stdio: 'pipe' });
// Explicit '-' is ad-hoc only. No certificate/keychain configuration is read.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
if (signature.status !== 0 || !/Signature=adhoc/.test(signature.stderr)) throw new Error('Expected an explicitly ad-hoc signed early-access build.');
const zip = join(output, `getaudit-${version}-macos-arm64-early-access.zip`);
rmSync(zip, { force: true });
execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl', '--keepParent', app, zip]);
const archiveEntries = execFileSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
if (archiveEntries.some(path => /(?:^|\/)(?:__MACOSX|\._[^/]*)\//.test(path) || /(?:^|\/)\._[^/]*$/.test(path)))
  throw new Error('The public archive must not include AppleDouble or inherited file metadata.');
const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(join(output, basename(zip) + '.sha256'), sha256 + '  ' + basename(zip) + '\n');
writeFileSync(join(output, 'build-receipt.json'), JSON.stringify({ ...releaseInfo, artifact: basename(zip), sha256,
  sourcePackageVersion: version, runtimeElectron: JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'))).version }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: zip, sha256, app, ...releaseInfo }, null, 2));
