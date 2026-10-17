import { packager } from "@electron/packager";
import {
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { resolveSigningConfig, signDesktopApp } from "./mac-signing.mjs";
import { readGoogleOwnerClient, googleOwnerClientCredentials, validGoogleClientId } from "../src/console/google-client-config.ts";
// Fail before overwriting an earlier package if a stable identity is missing.
const signing = resolveSigningConfig();
const stage = resolve("out/desktop-stage");
const version=JSON.parse(readFileSync('package.json','utf8')).version;
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const dir of ["dist-node", "dist/console", "desktop"])
  cpSync(resolve(dir), join(stage, dir), { recursive: true });
// The owner supplies registered Desktop metadata. A Desktop client_secret may
// be required by Google, but cannot authenticate a public installed app by itself.
// Never distribute web-client credentials, refresh tokens or per-user data.
const publicClientPath=join(stage,'desktop/google-oauth-client.json');
const configuredClient=process.env.GETAUDIT_GOOGLE_CLIENT_ID;
const ownerClientPath=process.env.GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE;
let ownerClient=readGoogleOwnerClient(ownerClientPath||publicClientPath);
if((ownerClientPath||existsSync(publicClientPath))&&!ownerClient)throw new Error('Invalid Google Desktop configuration. Use only a registered public client ID or the official installed Desktop envelope; web credentials and user tokens are forbidden.');
if(configuredClient){
  if(!validGoogleClientId(configuredClient))throw new Error('Invalid owner Google Desktop client ID.');
  if(ownerClient&&googleOwnerClientCredentials(ownerClient).clientId!==configuredClient)throw new Error('Google Desktop client ID does not match the owner configuration.');
  ownerClient??={clientId:configuredClient};
}
if(ownerClient){writeFileSync(publicClientPath,JSON.stringify(ownerClient,null,2)+'\n',{mode:0o600});chmodSync(publicClientPath,0o600);}
else console.warn('Google user sign-in is awaiting app-owner Desktop OAuth configuration. No placeholder client was bundled.');
mkdirSync(join(stage, "node_modules"), { recursive: true });
cpSync("node_modules/zod", join(stage, "node_modules/zod"), {
  recursive: true,
});
cpSync("node_modules/re2js", join(stage,"node_modules/re2js"), {recursive:true});
cpSync("node_modules/playwright-core", join(stage, "node_modules/playwright-core"), { recursive: true });
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "getaudit",
      productName: "getaudit",
      version,
      type: "module",
      main: "desktop/main.cjs",
      description: "Local GEO evidence console",
      author: "getaudit contributors",
      dependencies: {
        re2js: JSON.parse(readFileSync("node_modules/re2js/package.json")).version,
        zod: JSON.parse(readFileSync("node_modules/zod/package.json")).version,
        "playwright-core": JSON.parse(readFileSync("node_modules/playwright-core/package.json")).version,
      },
    },
    null,
    2,
  ),
);
const forbidden = [];
function check(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) check(p);
    else if (/\.db(?:-|$)|^\.env|\.enc$|\.log$/.test(f.name)) forbidden.push(p);
  }
}
check(stage);
if (forbidden.length)
  throw new Error("Private artifacts in bundle: " + forbidden.join(","));
const paths = await packager({
  dir: stage,
  name: "getaudit",
  appBundleId: "org.getaudit.community",
  icon: resolve("desktop/assets/geo.icns"),
  appVersion: version,
  platform: "darwin",
  arch: process.arch,
  electronVersion: JSON.parse(
    readFileSync("node_modules/electron/package.json"),
  ).version,
  out: resolve(process.env.GEO_PACKAGE_OUTPUT || "out/desktop"),
  overwrite: true,
  asar: true,
  prune: false,
  appCategoryType: "public.app-category.business",
  darwinDarkModeSupport: false,
});
// Local certificates keep Keychain identity stable across builds. Public
// distribution additionally requires Developer ID signing and notarization.
for (const output of paths) {
  const app = join(output, "getaudit.app");
  await signDesktopApp(app, signing);
}
console.log(paths.join("\n"));
