import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const readmePath = path.join(projectRoot, "README.md");
const agentsPath = path.join(projectRoot, "AGENTS.md");
const deploymentSkillPath = path.join(
  projectRoot,
  ".agents/skills/deploy-movie-harbor-ubuntu/SKILL.md",
);

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
    "video-conversion.md",
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

test("project deployment skill has resolvable local references", () => {
  assert.ok(existsSync(deploymentSkillPath), "deployment skill is missing");
  const targets = localMarkdownTargets(deploymentSkillPath);
  assert.ok(
    targets.includes(
      path.join(
        projectRoot,
        ".agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md",
      ),
    ),
    "deployment skill must link its runbook",
  );
  for (const target of targets) {
    assert.ok(existsSync(target), `deployment skill has a broken link to ${target}`);
  }
});

test("AGENTS delegates Ubuntu deployment details to the project skill", () => {
  const agents = readFileSync(agentsPath, "utf8");
  assert.ok(
    !agents.includes("## Ubuntu 半离线部署流程"),
    "AGENTS still duplicates the Ubuntu deployment runbook",
  );
  assert.ok(
    !agents.includes("2026-10-10-ubuntu-offline-deployment-runbook"),
    "AGENTS still links the superseded deployment documents",
  );
  assert.ok(
    !existsSync(
      path.join(
        projectRoot,
        "docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md",
      ),
    ),
    "superseded AGENTS deployment plan still exists",
  );
});
