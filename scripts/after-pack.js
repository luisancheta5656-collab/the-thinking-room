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
};
