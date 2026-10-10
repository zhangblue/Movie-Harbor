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

test("AGENTS scopes project process rules to the actual change", () => {
  const agents = readFileSync(agentsPath, "utf8");

  assert.match(agents, /修改产品行为、接口、数据结构、媒体生命周期或部署机制前/);
  assert.match(agents, /纯文档、格式、注释、已有流程执行和只读审阅/);
  assert.match(agents, /用户本次明确要求[\s\S]*最新且已确认的增量规格[\s\S]*主规格/);
  assert.match(agents, /当前实现只作为现状证据，不自动覆盖规格/);
  assert.match(agents, /当任务已有经用户确认的实现计划时/);
  assert.match(agents, /文档、Skill、静态配置和一次性运维规则/);
  assert.match(agents, /不需要为跳过无关检查向用户确认/);
  assert.match(agents, /只执行已发布且已验证的部署包/);
});

test("AGENTS distinguishes disaster recovery from deployment safety backup", () => {
  const agents = readFileSync(agentsPath, "utf8");
  assert.match(agents, /完整灾难恢复[\s\S]*数据库和媒体作为同一一致性备份集/);
  assert.match(agents, /仅升级应用且保证媒体目录不变[\s\S]*只创建数据库和部署文件安全备份/);
  assert.match(agents, /迁移前置条件要求媒体一致备份[\s\S]*取得媒体备份明确授权/);
});

test("deployment skill separates standard authorization from data recovery approval", () => {
  const skill = readFileSync(deploymentSkillPath, "utf8");
  const runbookPath = path.join(
    projectRoot,
    ".agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md",
  );
  const runbook = readFileSync(runbookPath, "utf8");

  assert.match(skill, /明确要求将指定发布包部署或升级[\s\S]*不再请求部署总确认/);
  assert.match(skill, /停止向前升级[\s\S]*应用级回滚/);
  assert.match(skill, /数据库恢复与媒体备份[\s\S]*当次明确授权/);
  assert.match(runbook, /标准部署授权[\s\S]*既定 SSH 主机上传/);
  assert.match(runbook, /恢复字节一致且哈希匹配的原 `.env` 备份/);
  assert.match(runbook, /不得编辑、猜测、补写或重建/);
  assert.match(runbook, /数据库恢复[\s\S]*媒体备份[\s\S]*重新取得明确授权/);
});
