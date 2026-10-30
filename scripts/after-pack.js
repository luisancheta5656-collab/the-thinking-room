// electron-builder afterPack hook: copy the Next.js standalone server into
// resources/app-server. extraResources would silently drop its node_modules.

const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const root = context.packager.projectDir;
  const target = path.join(context.appOutDir, "resources", "app-server");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(root, ".next", "standalone"), target, { recursive: true, dereference: true });
  fs.cpSync(path.join(root, ".next", "static"), path.join(target, ".next", "static"), { recursive: true });
  fs.cpSync(path.join(root, "public"), path.join(target, "public"), { recursive: true });

  // Next.js records the build machine's project path in its saved config (used only while
  // building). Replace it so the installer doesn't reveal the builder's folder or user name.
  // The path appears JSON-escaped (doubled backslashes); Windows paths ignore case, e.g. "c:" vs "C:".
  const recordedRoot = JSON.stringify(root).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const file of ["server.js", path.join(".next", "required-server-files.json")]) {
    const fullPath = path.join(target, file);
    const text = fs.readFileSync(fullPath, "utf8");
    fs.writeFileSync(fullPath, text.replace(new RegExp(recordedRoot, "gi"), "."));
  }
};
