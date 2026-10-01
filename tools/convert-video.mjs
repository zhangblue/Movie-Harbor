import { stat, lstat } from "node:fs/promises";
import { resolve, parse, format } from "node:path";
import { pathToFileURL } from "node:url";
import { buildConversionPlan } from "./video-conversion/plan.mjs";
import { probeMedia, verifyRequiredEncoders, executeConversion } from "./video-conversion/execute.mjs";

const help = "用法：node tools/convert-video.mjs <本机 .mkv 或 .mp4 文件>\n      node tools/convert-video.mjs --help\n输出：同目录下 <文件名>.movie-harbor.mp4；已有目标不会覆盖。";

export async function run(argv, dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (argv.length === 1 && argv[0] === "--help") { stdout.write(`${help}\n`); return 0; }
  if (argv.length !== 1 || argv[0].startsWith("-")) {
    stderr.write(`ERROR 请提供恰好一个本机视频路径；唯一选项是 --help\n${help}\n`); return 2;
  }
  const inputPath = resolve(argv[0]);
  const path = parse(inputPath);
  if (![".mkv", ".mp4"].includes(path.ext.toLowerCase())) {
    stderr.write("ERROR 只支持 .mkv 或 .mp4 文件\n"); return 2;
  }
  const outputPath = format({ dir: path.dir, name: `${path.name}.movie-harbor`, ext: ".mp4" });
  try {
    let input;
    try { input = await stat(inputPath); }
    catch (error) { throw new Error(`无法读取输入 ${inputPath}：${error.message}`); }
    if (!input.isFile()) throw new Error(`输入不是普通文件：${inputPath}`);
    try {
      await lstat(outputPath);
      throw new Error(`目标已存在：${outputPath}，请移动已有文件后重试`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const media = await (dependencies.probeMedia ?? probeMedia)(inputPath);
    const plan = (dependencies.buildConversionPlan ?? buildConversionPlan)(media);
    await (dependencies.verifyRequiredEncoders ?? verifyRequiredEncoders)(plan.requiredEncoders);
    await (dependencies.executeConversion ?? executeConversion)({ inputPath, outputPath, media, plan }, {
      onProgress: (message) => stdout.write(`${message}\n`),
    });
    stdout.write(`完成：${outputPath}\n`); return 0;
  } catch (error) { stderr.write(`ERROR ${error.message}\n`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
