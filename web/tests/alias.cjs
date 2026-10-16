// "@/…" imports of the compiled unit tests → .test-dist/src/… (tsconfig paths).
const Module = require("node:module");
const path = require("node:path");
const root = path.join(__dirname, "..", ".test-dist", "src");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
