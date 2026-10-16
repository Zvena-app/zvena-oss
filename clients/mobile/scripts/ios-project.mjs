// Adds zvena's own parts to the Xcode project that `npx cap add ios`
// generated (cap sync never rewrites project.pbxproj, so this runs once, and
// again only if ios/ is generated anew): Links.swift and the entitlements of
// the app, and the "Save to zvena" share extension target, embedded in the
// app. Idempotent: a project that has them is left as it is.
//   node scripts/ios-project.mjs
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "ios/App/App.xcodeproj/project.pbxproj");
let p = readFileSync(file, "utf8");

if (p.includes("ShareExtension.appex")) {
  console.log("project already has the share extension");
  process.exit(0);
}

/** Stable 24-hex ids (the same on every run, so a rerun on a fresh project gives the same file). */
const id = (name) => createHash("sha1").update(`zvena:${name}`).digest("hex").slice(0, 24).toUpperCase();

// The template's fixed ids.
const PROJECT = "504EC2FC1FED79650016851F";
const APP_TARGET = "504EC3031FED79650016851F";
const APP_GROUP = "504EC3061FED79650016851F";
const MAIN_GROUP = "504EC2FB1FED79650016851F";
const PRODUCTS = "504EC3051FED79650016851F";
const APP_SOURCES = "504EC3001FED79650016851F";
for (const must of [PROJECT, APP_TARGET, APP_GROUP, MAIN_GROUP, PRODUCTS, APP_SOURCES]) {
  if (!p.includes(must)) throw new Error(`unexpected project layout (no ${must}); add the extension in Xcode instead (README)`);
}

const langs = readdirSync(join(root, "ios/App/ShareExtension")).filter((d) => d.endsWith(".lproj")).map((d) => d.replace(/\.lproj$/, "")).sort();

const I = {
  links: id("Links.swift"),
  linksBuild: id("Links.swift in Sources"),
  appEnt: id("App.entitlements"),
  group: id("ShareExtension group"),
  vc: id("ShareViewController.swift"),
  vcBuild: id("ShareViewController.swift in Sources"),
  plist: id("ShareExtension Info.plist"),
  ent: id("ShareExtension.entitlements"),
  strings: id("Localizable.strings"),
  stringsBuild: id("Localizable.strings in Resources"),
  plistStrings: id("InfoPlist.strings"),
  plistStringsBuild: id("InfoPlist.strings in Resources"),
  appex: id("ShareExtension.appex"),
  appexEmbed: id("ShareExtension.appex in Embed Foundation Extensions"),
  embedPhase: id("Embed Foundation Extensions"),
  target: id("ShareExtension target"),
  sources: id("ShareExtension Sources"),
  frameworks: id("ShareExtension Frameworks"),
  resources: id("ShareExtension Resources"),
  configList: id("ShareExtension configuration list"),
  debug: id("ShareExtension Debug"),
  release: id("ShareExtension Release"),
  proxy: id("ShareExtension proxy"),
  dependency: id("ShareExtension dependency"),
};
const langRef = (kind, l) => id(`${kind} ${l}`);
/** A value as Xcode writes it: quoted unless plain letters, numbers, dots, slashes and underscores. */
const q = (v) => (/^[A-Za-z0-9_./]+$/.test(v) ? v : `"${v}"`);

/** Inserts `text` just before the end marker of a section (creating the section if missing). */
function intoSection(name, text) {
  const end = `/* End ${name} section */`;
  if (!p.includes(end)) {
    const before = "/* Begin XCBuildConfiguration section */";
    p = p.replace(before, `/* Begin ${name} section */\n${text}/* End ${name} section */\n\n${before}`);
    return;
  }
  p = p.replace(end, `${text}${end}`);
}

/** Adds `items` to the list `key = ( … );` inside the object `objId`. */
function intoList(objId, key, items) {
  const start = p.indexOf(`\n\t\t${objId} `);
  if (start < 0) throw new Error(`no object ${objId}`);
  const k = p.indexOf(`${key} = (`, start);
  const close = p.indexOf(");", k);
  p = `${p.slice(0, close)}${items.map((x) => `\t${x},\n\t\t\t`).join("")}${p.slice(close)}`;
}

/** Adds settings to both build configurations of the app target. */
function appSetting(line) {
  for (const cfg of ["504EC3171FED79650016851F", "504EC3181FED79650016851F"]) {
    const start = p.indexOf(`\n\t\t${cfg} `);
    const at = p.indexOf("buildSettings = {", start) + "buildSettings = {".length;
    p = `${p.slice(0, at)}\n\t\t\t\t${line}${p.slice(at)}`;
  }
}

intoSection(
  "PBXBuildFile",
  [
    `\t\t${I.linksBuild} /* Links.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${I.links} /* Links.swift */; };\n`,
    `\t\t${I.vcBuild} /* ShareViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${I.vc} /* ShareViewController.swift */; };\n`,
    `\t\t${I.stringsBuild} /* Localizable.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${I.strings} /* Localizable.strings */; };\n`,
    `\t\t${I.plistStringsBuild} /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${I.plistStrings} /* InfoPlist.strings */; };\n`,
    `\t\t${I.appexEmbed} /* ShareExtension.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile; fileRef = ${I.appex} /* ShareExtension.appex */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); }; };\n`,
  ].join("")
);

intoSection(
  "PBXContainerItemProxy",
  `\t\t${I.proxy} /* PBXContainerItemProxy */ = {\n\t\t\tisa = PBXContainerItemProxy;\n\t\t\tcontainerPortal = ${PROJECT} /* Project object */;\n\t\t\tproxyType = 1;\n\t\t\tremoteGlobalIDString = ${I.target};\n\t\t\tremoteInfo = ShareExtension;\n\t\t};\n`
);

intoSection(
  "PBXCopyFilesBuildPhase",
  `\t\t${I.embedPhase} /* Embed Foundation Extensions */ = {\n\t\t\tisa = PBXCopyFilesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tdstPath = "";\n\t\t\tdstSubfolderSpec = 13;\n\t\t\tfiles = (\n\t\t\t\t${I.appexEmbed} /* ShareExtension.appex in Embed Foundation Extensions */,\n\t\t\t);\n\t\t\tname = "Embed Foundation Extensions";\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`
);

intoSection(
  "PBXFileReference",
  [
    `\t\t${I.links} /* Links.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Links.swift; sourceTree = "<group>"; };\n`,
    `\t\t${I.appEnt} /* App.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = App.entitlements; sourceTree = "<group>"; };\n`,
    `\t\t${I.vc} /* ShareViewController.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ShareViewController.swift; sourceTree = "<group>"; };\n`,
    `\t\t${I.plist} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };\n`,
    `\t\t${I.ent} /* ShareExtension.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; path = ShareExtension.entitlements; sourceTree = "<group>"; };\n`,
    `\t\t${I.appex} /* ShareExtension.appex */ = {isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; includeInIndex = 0; path = ShareExtension.appex; sourceTree = BUILT_PRODUCTS_DIR; };\n`,
    ...langs.flatMap((l) => [
      `\t\t${langRef("Localizable", l)} /* ${l} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = ${q(l)}; path = ${q(`${l}.lproj/Localizable.strings`)}; sourceTree = "<group>"; };\n`,
      `\t\t${langRef("InfoPlist", l)} /* ${l} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = ${q(l)}; path = ${q(`${l}.lproj/InfoPlist.strings`)}; sourceTree = "<group>"; };\n`,
    ]),
  ].join("")
);

intoSection(
  "PBXFrameworksBuildPhase",
  `\t\t${I.frameworks} /* Frameworks */ = {\n\t\t\tisa = PBXFrameworksBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`
);

intoSection(
  "PBXGroup",
  `\t\t${I.group} /* ShareExtension */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t${I.vc} /* ShareViewController.swift */,\n\t\t\t\t${I.strings} /* Localizable.strings */,\n\t\t\t\t${I.plistStrings} /* InfoPlist.strings */,\n\t\t\t\t${I.plist} /* Info.plist */,\n\t\t\t\t${I.ent} /* ShareExtension.entitlements */,\n\t\t\t);\n\t\t\tpath = ShareExtension;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`
);
intoList(MAIN_GROUP, "children", [`${I.group} /* ShareExtension */`]);
intoList(PRODUCTS, "children", [`${I.appex} /* ShareExtension.appex */`]);
intoList(APP_GROUP, "children", [`${I.links} /* Links.swift */`, `${I.appEnt} /* App.entitlements */`]);

intoSection(
  "PBXNativeTarget",
  `\t\t${I.target} /* ShareExtension */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = ${I.configList} /* Build configuration list for PBXNativeTarget "ShareExtension" */;\n\t\t\tbuildPhases = (\n\t\t\t\t${I.sources} /* Sources */,\n\t\t\t\t${I.frameworks} /* Frameworks */,\n\t\t\t\t${I.resources} /* Resources */,\n\t\t\t);\n\t\t\tbuildRules = (\n\t\t\t);\n\t\t\tdependencies = (\n\t\t\t);\n\t\t\tname = ShareExtension;\n\t\t\tproductName = ShareExtension;\n\t\t\tproductReference = ${I.appex} /* ShareExtension.appex */;\n\t\t\tproductType = "com.apple.product-type.app-extension";\n\t\t};\n`
);
intoList(APP_TARGET, "buildPhases", [`${I.embedPhase} /* Embed Foundation Extensions */`]);
intoList(APP_TARGET, "dependencies", [`${I.dependency} /* PBXTargetDependency */`]);

// The project: the new target, its attributes and the languages.
intoList(PROJECT, "targets", [`${I.target} /* ShareExtension */`]);
p = p.replace(
  /(TargetAttributes = \{\n)/,
  `$1\t\t\t\t\t${I.target} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;\n\t\t\t\t\t\tProvisioningStyle = Automatic;\n\t\t\t\t\t};\n`
);
p = p.replace(/knownRegions = \(\n\t\t\t\ten,\n\t\t\t\tBase,\n\t\t\t\);/, `knownRegions = (\n${["en", "Base", ...langs.filter((l) => l !== "en")].map((l) => `\t\t\t\t${q(l)},\n`).join("")}\t\t\t);`);

intoSection(
  "PBXResourcesBuildPhase",
  `\t\t${I.resources} /* Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\t${I.stringsBuild} /* Localizable.strings in Resources */,\n\t\t\t\t${I.plistStringsBuild} /* InfoPlist.strings in Resources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`
);

intoSection(
  "PBXSourcesBuildPhase",
  `\t\t${I.sources} /* Sources */ = {\n\t\t\tisa = PBXSourcesBuildPhase;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t\t${I.vcBuild} /* ShareViewController.swift in Sources */,\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t};\n`
);
intoList(APP_SOURCES, "files", [`${I.linksBuild} /* Links.swift in Sources */`]);

intoSection(
  "PBXTargetDependency",
  `\t\t${I.dependency} /* PBXTargetDependency */ = {\n\t\t\tisa = PBXTargetDependency;\n\t\t\ttarget = ${I.target} /* ShareExtension */;\n\t\t\ttargetProxy = ${I.proxy} /* PBXContainerItemProxy */;\n\t\t};\n`
);

const variant = (ref, name, kind) =>
  `\t\t${ref} /* ${name} */ = {\n\t\t\tisa = PBXVariantGroup;\n\t\t\tchildren = (\n${langs.map((l) => `\t\t\t\t${langRef(kind, l)} /* ${l} */,\n`).join("")}\t\t\t);\n\t\t\tname = ${name};\n\t\t\tsourceTree = "<group>";\n\t\t};\n`;
intoSection("PBXVariantGroup", variant(I.strings, "Localizable.strings", "Localizable") + variant(I.plistStrings, "InfoPlist.strings", "InfoPlist"));

const extConfig = (cfgId, name) =>
  `\t\t${cfgId} /* ${name} */ = {\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = {\n` +
  [
    // The extension opens the app through the responder chain (ShareViewController.openApp).
    "APPLICATION_EXTENSION_API_ONLY = NO;",
    "CODE_SIGN_ENTITLEMENTS = ShareExtension/ShareExtension.entitlements;",
    "CODE_SIGN_STYLE = Automatic;",
    "CURRENT_PROJECT_VERSION = 1;",
    "INFOPLIST_FILE = ShareExtension/Info.plist;",
    "IPHONEOS_DEPLOYMENT_TARGET = 15.0;",
    'LD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t\t"@executable_path/../../Frameworks",\n\t\t\t\t);',
    "MARKETING_VERSION = 1.0;",
    "PRODUCT_BUNDLE_IDENTIFIER = app.zvena.mobile.share;",
    'PRODUCT_NAME = "$(TARGET_NAME)";',
    "SKIP_INSTALL = YES;",
    name === "Debug" ? "SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG;" : 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "";',
    "SWIFT_EMIT_LOC_STRINGS = YES;",
    "SWIFT_VERSION = 5.0;",
    'TARGETED_DEVICE_FAMILY = "1,2";',
  ]
    .map((l) => `\t\t\t\t${l}\n`)
    .join("") +
  `\t\t\t};\n\t\t\tname = ${name};\n\t\t};\n`;
intoSection("XCBuildConfiguration", extConfig(I.debug, "Debug") + extConfig(I.release, "Release"));
intoSection(
  "XCConfigurationList",
  `\t\t${I.configList} /* Build configuration list for PBXNativeTarget "ShareExtension" */ = {\n\t\t\tisa = XCConfigurationList;\n\t\t\tbuildConfigurations = (\n\t\t\t\t${I.debug} /* Debug */,\n\t\t\t\t${I.release} /* Release */,\n\t\t\t);\n\t\t\tdefaultConfigurationIsVisible = 0;\n\t\t\tdefaultConfigurationName = Release;\n\t\t};\n`
);

appSetting("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;");

writeFileSync(file, p);
console.log(`share extension added (${langs.length} languages)`);
