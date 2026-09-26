import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const readmePath = path.join(projectRoot, "README.md");

function localMarkdownTargets(file) {
  const content = readFileSync(file, "utf8");
  return [...content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].split("#", 1)[0])
    .filter((target) => target && !/^[a-z]+:/i.test(target))
    .map((target) => path.resolve(path.dirname(file), decodeURI(target)));
}

test("README guide navigation and guide links resolve", () => {
  const guides = [
    "deployment.md",
    "offline-package.md",
    "content-transfer.md",
    "media-and-backup.md",
    "development.md",
    "database-schema.md",
  ];
  const readmeTargets = new Set(localMarkdownTargets(readmePath));

  for (const target of readmeTargets) {
    assert.ok(existsSync(target), `README has a broken link to ${target}`);
  }

  for (const name of guides) {
    const guidePath = path.join(projectRoot, "docs/guides", name);
    assert.ok(readmeTargets.has(guidePath), `${name} is missing from README`);
    const targets = localMarkdownTargets(guidePath);
    assert.ok(targets.includes(readmePath), `${name} does not link back to README`);
    for (const target of targets) {
      assert.ok(existsSync(target), `${name} has a broken link to ${target}`);
    }
  }
});
