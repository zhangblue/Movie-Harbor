import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) return sourceFiles(path);
    if (entry.isDirectory()) return [];
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function unknownTypeLocations(directory) {
  const failures = [];
  for (const path of sourceFiles(resolve(root, directory))) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (node.kind === ts.SyntaxKind.UnknownKeyword) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${relative(root, path)}:${position.line + 1}:${position.character + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

test("api-client uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/packages/api-client"), []);
});

test("public web uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/public-web"), []);
});
