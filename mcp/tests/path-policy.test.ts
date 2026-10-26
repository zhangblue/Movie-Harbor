import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectAllowedFile, revalidateAllowedFile } from '../src/services/path-policy.js';

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mh-path-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const downloads = join(dir, 'downloads');
  await mkdir(downloads);
  const video = join(downloads, 'video.mp4');
  await writeFile(video, 'video');
  return { dir, downloads, video };
}

// Catches dropping realpath resolution or comparing directory string prefixes.
test('rejects symlink escapes and sibling paths with shared prefix', async (t) => {
  const f = await fixture(t);
  const sibling = join(f.dir, 'downloads-extra');
  await mkdir(sibling);
  const outside = join(sibling, 'outside.mp4');
  await writeFile(outside, 'outside');
  const link = join(f.downloads, 'link.mp4');
  await symlink(outside, link);
  await assert.rejects(inspectAllowedFile(link, [f.downloads]), /不在允许目录/);
  await assert.rejects(inspectAllowedFile(outside, [f.downloads]), /不在允许目录/);
});

test('allows internal symlinks and canonicalizes allowed roots', async (t) => {
  const f = await fixture(t);
  const alias = join(f.dir, 'allowed');
  const link = join(f.downloads, 'link.mp4');
  await symlink(f.downloads, alias);
  await symlink(f.video, link);
  const checked = await inspectAllowedFile(link, [alias]);
  assert.equal(checked.requestedPath, link);
  assert.equal(checked.realPath, f.video);
  assert.equal(typeof checked.identity.dev, 'bigint');
  assert.equal(typeof checked.identity.ino, 'bigint');
  assert.equal(checked.identity.size, 5);
  await revalidateAllowedFile(checked, [alias]);
});

test('rejects nonregular files and an empty allowlist', async (t) => {
  const f = await fixture(t);
  await assert.rejects(inspectAllowedFile(f.downloads, [f.downloads]), /普通文件/);
  await assert.rejects(inspectAllowedFile(f.video, []), /不在允许目录/);
});

// Catches missing size / inode comparisons and failure to resolve requested path again.
test('revalidation rejects mutation, replacement and retargeted links', async (t) => {
  for (const mutation of ['write', 'replace', 'retarget'] as const) {
    const f = await fixture(t);
    const link = join(f.downloads, 'link.mp4');
    await symlink(f.video, link);
    const checked = await inspectAllowedFile(link, [f.downloads]);
    if (mutation === 'write') await writeFile(f.video, 'longer video');
    else {
      const replacement = join(f.downloads, 'replacement.mp4');
      await writeFile(replacement, 'video');
      if (mutation === 'replace') await rename(replacement, f.video);
      else { await rm(link); await symlink(replacement, link); }
    }
    await assert.rejects(revalidateAllowedFile(checked, [f.downloads]), /文件已经变化/);
  }
});

test('revalidation applies current allowed roots', async (t) => {
  const f = await fixture(t);
  const checked = await inspectAllowedFile(f.video, [f.downloads]);
  await assert.rejects(revalidateAllowedFile(checked, []), /不在允许目录/);
});

// Catches truncating submillisecond timestamps while content size is unchanged.
test('revalidation detects same-size submillisecond timestamp changes', async (t) => {
  const f = await fixture(t);
  await utimes(f.video, 1700000000.0001, 1700000000.0001);
  const checked = await inspectAllowedFile(f.video, [f.downloads]);
  await utimes(f.video, 1700000000.0009, 1700000000.0009);
  await assert.rejects(revalidateAllowedFile(checked, [f.downloads]), /文件已经变化/);
});
