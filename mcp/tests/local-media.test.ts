import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test, type TestContext } from 'node:test';
import { probeMedia, verifyRequiredEncoders, executeConversion } from '../../tools/video-conversion/execute.mjs';
import { inspectVideoTool, validatePosterTool, convertVideoTool, deleteGeneratedVideoTool, registerLocalMediaTools, type LocalMediaDependencies } from '../src/tools/local-media.js';
import type { McpConfig } from '../src/config.js';

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mh-local-media-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowed = join(directory, 'allowed');
  const credentialDirectory = join(directory, 'credentials');
  const bin = join(directory, 'bin');
  await Promise.all([mkdir(allowed), mkdir(credentialDirectory), mkdir(bin)]);
  const input = join(allowed, '电影 ; $(unsafe).mkv');
  const bytes = Buffer.from('private video content that must never enter tool results');
  await writeFile(input, bytes);
  const media = { format: { duration: '9.1' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', tags: { secret: 'tag-secret' } },
    { index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'zho', title: '中文', secret: 'tag-secret' } },
  ] };
  await writeFile(join(bin, 'ffprobe'), `#!${process.execPath}\nprocess.stdout.write(process.env.MEDIA_FIXTURE);\n`, { mode: 0o755 });
  await writeFile(join(bin, 'ffmpeg'), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); if(args.includes('-encoders')) process.stdout.write(' V..... libx264 H264\\n A..... aac AAC\\n S..... mov_text text\\n'); else {fs.writeFileSync(args.at(-1), 'converted'); process.stdout.write('out_time_us=1000000\\nprogress=end\\n');}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, MEDIA_FIXTURE: JSON.stringify(media) };
  const config: McpConfig = { baseUrl: new URL('http://localhost/'), apiKey: 'mhmcp_never-return-this', allowedRoots: [allowed], generatedRoot: join(allowed, 'generated'), requestTimeoutMs: 1000 };
  const deps: LocalMediaDependencies = { config, credentialDirectory, verifyRequiredEncoders: (encoders) => verifyRequiredEncoders(encoders, { env }), probeMedia: (path) => probeMedia(path, { env }), executeConversion: (conversion) => executeConversion(conversion, { env }) };
  return { directory, allowed, input, bytes, media, env, config, deps, credentialDirectory };
}

// Catches rounding down duration, leaking raw probe tags or dropping selected tracks.
test('video metadata includes compatibility and a conversion plan without file bytes or raw tags', async t => {
  const f = await fixture(t);
  const result = await inspectVideoTool({ path: f.input }, f.deps);
  const out = result.structuredContent;
  assert.equal(out.duration_seconds, 10);
  assert.deepEqual(out.video, { index: 0, codec: 'h264', pixel_format: 'yuv420p' });
  assert.deepEqual(out.audio_tracks, [{ index: 2, codec: 'aac', language: 'zho', title: '中文' }]);
  assert.equal(out.container, 'mkv'); assert.equal(out.compatibility.accepted, false);
  assert.equal(out.compatibility.conversion_required, true);
  assert.deepEqual(out.conversion_plan, { video_mode: 'copy', audio_modes: ['copy'], subtitle_modes: [], required_encoders: [] });
  assert.equal(typeof out.identity.dev, 'string');
  assert.equal(JSON.stringify(result).includes(f.bytes.toString('base64')), false);
  assert.doesNotMatch(JSON.stringify(result), /tag-secret|mhmcp_never|disposition|attachedPic/);
  const mp4 = join(f.allowed, 'video.mp4'); await writeFile(mp4, f.bytes);
  assert.equal((await inspectVideoTool({ path: mp4 }, f.deps)).structuredContent.compatibility.accepted, true);
  f.env.MEDIA_FIXTURE = JSON.stringify({ ...f.media, format: { duration: 'N/A' } });
  assert.equal((await inspectVideoTool({ path: mp4 }, f.deps)).structuredContent.duration_seconds, null);
});

// Catches bypassing path checks or forwarding arbitrary external-process diagnostics.
test('video rejects invalid paths and sanitizes probe errors', async t => {
  const f = await fixture(t);
  await assert.rejects(inspectVideoTool({ path: 'relative.mp4' }, f.deps), /绝对路径/);
  await assert.rejects(inspectVideoTool({ path: `${f.input}\0` }, f.deps), /路径/);
  const outside = join(f.directory, 'outside.mp4'); await writeFile(outside, 'outside');
  await assert.rejects(inspectVideoTool({ path: outside }, f.deps), /允许目录/);
  const leaking = { ...f.deps, probeMedia: async () => { throw new Error(`sensitive:${f.config.apiKey}:${f.bytes.toString('base64')}`); } };
  await assert.rejects(inspectVideoTool({ path: f.input }, leaking), error => /探测/.test(String(error)) && !String(error).includes(f.config.apiKey));
});

// Catches trusting extension only or accepting truncated image signatures.
test('poster checks bounded content, extension and serialized identity', async t => {
  const f = await fixture(t);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082', 'hex');
  const path = join(f.allowed, 'poster.png'); await writeFile(path, png);
  const out = (await validatePosterTool({ path }, f.deps)).structuredContent;
  assert.equal(out.format, 'png'); assert.equal(out.mime_type, 'image/png'); assert.equal(out.byte_size, png.length);
  assert.equal(typeof out.identity.ino, 'string');
  const fake = join(f.allowed, 'fake.jpg'); await writeFile(fake, png);
  await assert.rejects(validatePosterTool({ path: fake }, f.deps), /图片内容与扩展名不匹配/);
  const truncated = join(f.allowed, 'truncated.png'); await writeFile(truncated, png.subarray(0, 8));
  await assert.rejects(validatePosterTool({ path: truncated }, f.deps), /图片内容与扩展名不匹配/);
});

// Catches implicit conversion, missing persistence, open permissions or source deletion.
test('convert requires confirmation and persists generated identity for deletion', async t => {
  const f = await fixture(t);
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: false }, f.deps), /需要明确确认/);
  const converted = await convertVideoTool({ path: f.input, confirmed: true }, f.deps);
  const path = converted.structuredContent.output_path;
  assert.equal(dirname(path), f.config.generatedRoot); assert.match(path, /[a-f0-9-]{36}\.mp4$/);
  assert.equal(await readFile(path, 'utf8'), 'converted');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const registryPath = join(f.credentialDirectory, 'generated-files.json');
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(f.credentialDirectory)).mode & 0o777, 0o700);
  const registry = await readFile(registryPath, 'utf8');
  assert.ok(registry.includes(path)); assert.ok(registry.includes(converted.structuredContent.source_identity.ino));
  assert.equal(JSON.stringify(converted).includes(f.bytes.toString('base64')), false);
  await assert.rejects(deleteGeneratedVideoTool({ path: f.input }, f.deps), /不是 MCP 生成文件/);
  await deleteGeneratedVideoTool({ path }, f.deps);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await readFile(f.input, 'utf8'), f.bytes.toString());
  assert.deepEqual((await readdir(f.credentialDirectory)).filter(name => name.includes('.tmp')), []);
});

// Catches skipping source revalidation or deleting a replacement file under a registered name.
test('convert revalidates sources and generated deletion rejects replacements and symlink escapes', async t => {
  const f = await fixture(t);
  const mutating = { ...f.deps, probeMedia: async (path: string) => { const media = await f.deps.probeMedia!(path); await writeFile(f.input, 'changed source'); return media; } };
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: true }, mutating), /文件已经变化/);
  const converted = await convertVideoTool({ path: f.input, confirmed: true }, f.deps);
  const path = converted.structuredContent.output_path;
  const replacement = join(f.allowed, 'replacement.mp4'); await writeFile(replacement, 'converted'); await rename(replacement, path);
  await assert.rejects(deleteGeneratedVideoTool({ path }, f.deps), /身份|变化/);
  assert.equal(await readFile(path, 'utf8'), 'converted');
  const outside = join(f.directory, 'external.mp4'); await writeFile(outside, 'outside');
  await rm(path); await symlink(outside, path);
  await assert.rejects(deleteGeneratedVideoTool({ path }, f.deps), /允许目录|生成文件|身份|变化/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

// Catches missing independent registrations, result schemas or side-effect hints.
test('video and poster tools register independent schemas and safety annotations', async t => {
  const f = await fixture(t);
  const registrations = new Map<string, any>();
  registerLocalMediaTools({ registerTool(name: string, schema: any, handler: any) { registrations.set(name, { schema, handler }); } } as any, f.deps);
  assert.deepEqual([...registrations.keys()], ['inspect_video', 'validate_poster', 'convert_video', 'delete_generated_video']);
  for (const name of ['inspect_video', 'validate_poster']) assert.deepEqual(registrations.get(name).schema.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  assert.equal(registrations.get('convert_video').schema.annotations.readOnlyHint, false);
  assert.equal(registrations.get('delete_generated_video').schema.annotations.destructiveHint, true);
  const registration = registrations.get('inspect_video');
  assert.equal(registration.schema.outputSchema.safeParse((await registration.handler({ path: f.input })).structuredContent).success, true);
});

// Catches trusting a generatedRoot symlink that has been replaced after conversion.
test('generated deletion rejects a retargeted generated directory', async t => {
  const f = await fixture(t);
  const converted = await convertVideoTool({ path: f.input, confirmed: true }, f.deps);
  const outside = join(f.directory, 'moved-generated');
  await rename(f.config.generatedRoot, outside);
  await symlink(outside, f.config.generatedRoot);
  await assert.rejects(deleteGeneratedVideoTool({ path: converted.structuredContent.output_path }, f.deps), /生成目录|允许目录|身份/);
  assert.equal(await readFile(join(outside, converted.structuredContent.output_path.split('/').at(-1)!), 'utf8'), 'converted');
});

// Catches recording output after its controlled directory is swapped during conversion.
test('convert refuses registration after the generated directory escapes allowed roots', async t => {
  const f = await fixture(t);
  const outside = join(f.directory, 'escaped-generated');
  const replacing = { ...f.deps, executeConversion: async (conversion: VideoConversion.Conversion) => {
    await rename(f.config.generatedRoot, outside);
    await symlink(outside, f.config.generatedRoot);
    return f.deps.executeConversion!(conversion);
  } };
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: true }, replacing), /登记失败|生成目录/);
  await assert.rejects(stat(join(f.credentialDirectory, 'generated-files.json')), { code: 'ENOENT' });
});

// Catches failure to reuse encoder checks and accepting unsupported image subtitles.
test('convert reuses required encoder checks and refuses image subtitles before execution', async t => {
  const f = await fixture(t);
  f.env.MEDIA_FIXTURE = JSON.stringify({ ...f.media, streams: [{ ...f.media.streams[0], codec_name: 'hevc' }] });
  const inspected = (await inspectVideoTool({ path: f.input }, f.deps)).structuredContent;
  assert.deepEqual(inspected.conversion_plan?.required_encoders, ['libx264']);
  assert.equal(inspected.conversion_plan?.video_mode, 'transcode');
  const output = (await convertVideoTool({ path: f.input, confirmed: true }, f.deps)).structuredContent.output_path;
  assert.equal(await readFile(output, 'utf8'), 'converted');
  f.env.MEDIA_FIXTURE = JSON.stringify({ ...f.media, streams: [...f.media.streams, { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' }] });
  const blocked = (await inspectVideoTool({ path: f.input }, f.deps)).structuredContent;
  assert.equal(blocked.conversion_plan, null);
  assert.ok(blocked.compatibility.reasons.some(reason => reason.includes('图像字幕')));
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: true }, f.deps), /图像字幕/);
  assert.equal((await readdir(f.config.generatedRoot)).length, 1);
});

// Catches rejecting JPEG/WebP or accepting mismatched declared RIFF sizes.
test('poster supports JPEG and WebP signatures with bounded structural checks', async t => {
  const f = await fixture(t);
  const jpeg = join(f.allowed, 'photo.jpeg');
  await writeFile(jpeg, Buffer.from('ffd8ffe000044a46ffd9', 'hex'));
  assert.equal((await validatePosterTool({ path: jpeg }, f.deps)).structuredContent.format, 'jpeg');
  const webp = join(f.allowed, 'photo.webp');
  const bytes = Buffer.alloc(24);
  bytes.write('RIFF'); bytes.writeUInt32LE(16, 4); bytes.write('WEBPVP8 ', 8); bytes.writeUInt32LE(4, 16);
  await writeFile(webp, bytes);
  assert.equal((await validatePosterTool({ path: webp }, f.deps)).structuredContent.mime_type, 'image/webp');
  bytes.writeUInt32LE(200, 4); await writeFile(webp, bytes);
  await assert.rejects(validatePosterTool({ path: webp }, f.deps), /图片内容与扩展名不匹配/);
});

// Catches registering output from a source that changes while FFmpeg is running.
test('convert rejects source identity changes during execution before registering output', async t => {
  const f = await fixture(t);
  const changing = { ...f.deps, executeConversion: async (conversion: VideoConversion.Conversion) => {
    const output = await f.deps.executeConversion!(conversion);
    await writeFile(f.input, 'mutated during conversion');
    return output;
  } };
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: true }, changing), /文件已经变化|登记失败/);
  await assert.rejects(stat(join(f.credentialDirectory, 'generated-files.json')), { code: 'ENOENT' });
});

// Catches requiring the private output root to be part of the media input allowlist.
test('convert accepts an independent private generated root without expanding input access', async t => {
  const f = await fixture(t);
  f.config.generatedRoot = join(f.credentialDirectory, 'generated');
  const converted = await convertVideoTool({ path: f.input, confirmed: true }, f.deps);
  const output = converted.structuredContent.output_path;
  assert.equal(dirname(output), f.config.generatedRoot);
  assert.equal(await readFile(output, 'utf8'), 'converted');
  const registry = JSON.parse(await readFile(join(f.credentialDirectory, 'generated-files.json'), 'utf8'));
  assert.equal(registry.files[0].path, output);
  assert.deepEqual(registry.files[0].identity, converted.structuredContent.identity);
  await assert.rejects(convertVideoTool({ path: output, confirmed: true }, f.deps), /允许目录/);
  await deleteGeneratedVideoTool({ path: output }, f.deps);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(await readFile(f.input, 'utf8'), f.bytes.toString());
});

// Catches relaxing generated-directory and output-child checks when roots are separate.
test('independent generated roots still reject directory replacement and escaped outputs', async t => {
  const f = await fixture(t);
  f.config.generatedRoot = join(f.credentialDirectory, 'generated');
  const output = (await convertVideoTool({ path: f.input, confirmed: true }, f.deps)).structuredContent.output_path;
  const moved = join(f.directory, 'moved-private-generated');
  await rename(f.config.generatedRoot, moved);
  await symlink(moved, f.config.generatedRoot);
  await assert.rejects(deleteGeneratedVideoTool({ path: output }, f.deps), /生成目录|身份/);
  assert.equal(await readFile(join(moved, output.split('/').at(-1)!), 'utf8'), 'converted');

  const g = await fixture(t);
  g.config.generatedRoot = join(g.credentialDirectory, 'generated');
  const external = join(g.directory, 'external-output.mp4');
  await writeFile(external, 'external file');
  const escaping = { ...g.deps, executeConversion: async (conversion: VideoConversion.Conversion) => {
    await symlink(external, conversion.outputPath);
    return conversion.outputPath;
  } };
  await assert.rejects(convertVideoTool({ path: g.input, confirmed: true }, escaping), /登记失败/);
  await assert.rejects(stat(join(g.credentialDirectory, 'generated-files.json')), { code: 'ENOENT' });
  assert.equal(await readFile(external, 'utf8'), 'external file');
});

// Catches following a configured output parent that is retargeted during conversion.
test('independent generated root rejects parent path retargeting during conversion', async t => {
  const f = await fixture(t);
  const parent = join(f.directory, 'private-output');
  await mkdir(parent, { mode: 0o700 });
  f.config.generatedRoot = join(parent, 'generated');
  const moved = join(f.directory, 'retargeted-output');
  const retargeting = { ...f.deps, executeConversion: async (conversion: VideoConversion.Conversion) => {
    await rename(parent, moved);
    await symlink(moved, parent);
    return f.deps.executeConversion!(conversion);
  } };
  await assert.rejects(convertVideoTool({ path: f.input, confirmed: true }, retargeting), /登记失败/);
  await assert.rejects(stat(join(f.credentialDirectory, 'generated-files.json')), { code: 'ENOENT' });
});
