import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

// 递归查找前端源码，供显式类型检查使用。
function sourceFiles(directory) {
  // 递归读取目录并收集源码，供前端类型契约检查使用。
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) return sourceFiles(path);
    if (entry.isDirectory()) return [];
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// 解析源码并收集不符合约束的类型位置，供类型契约断言使用。
function unknownTypeLocations(directory) {
  const failures = [];
  for (const path of sourceFiles(resolve(root, directory))) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    // 遍历语法树并记录目标类型节点，供源码类型检查使用。
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

// 验证共享 API 客户端使用显式数据类型。
test("api-client uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/packages/api-client"), []);
});

// 验证公开站使用显式数据类型。
test("public web uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/public-web"), []);
});

// 验证管理后台和 E2E 辅助代码使用显式数据类型。
test("admin web and e2e helpers use explicit data types", () => {
  assert.deepEqual([
    ...unknownTypeLocations("frontend/admin-web"),
    ...unknownTypeLocations("frontend/packages/ui"),
    ...unknownTypeLocations("tests/e2e"),
  ], []);
});
