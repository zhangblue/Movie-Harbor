import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, link, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseProbeOutput } from "./probe.mjs";

function processError(executable, error) {
  if (error.code === "ENOENT" || error.code === "EACCES") {
    return new Error(`${executable} 未安装或不可执行，请安装 FFmpeg（含 FFprobe）并检查 PATH`);
  }
  return new Error(`${executable} 启动失败：${error.message}`);
}

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stderrBytes = 0, failure, interrupted;
    const forward = (signal) => { interrupted = signal; child.kill(signal); };
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    if (options.forwardSignals) {
      process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
    }
    child.on("error", (error) => { failure = processError(executable, error); });
    child.stdout.on("data", (chunk) => {
      if (options.onStdout) {
        try { options.onStdout(chunk); }
        catch (error) { failure ??= error; child.kill("SIGKILL"); }
      }
      else if (!failure) {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > (options.maxOutputBytes ?? 4 * 1024 * 1024)) {
          failure = new Error(`${executable} 标准输出超过大小限制`); child.kill("SIGKILL");
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr = Buffer.from(Buffer.concat([stderr, chunk]).subarray(-16 * 1024));
      if (options.limitStderr && stderrBytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) {
        failure ??= new Error(`${executable} 诊断输出超过大小限制`); child.kill("SIGKILL");
      }
    });
    child.on("close", (code, signal) => {
      if (options.forwardSignals) {
        process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate);
      }
      if (failure) reject(failure);
      else if (interrupted) reject(new Error(`转换已中断（${interrupted}），已停止 FFmpeg`));
      else if (code !== 0) reject(new Error(`${executable} 失败（${signal ?? code}）：${stderr.toString("utf8").trim() || "请检查输入文件、编码器和可用磁盘空间"}`));
      else resolve(stdout.toString("utf8"));
    });
  });
}

export async function probeMedia(inputPath, options = {}) {
  const text = await runProcess(options.ffprobe ?? "ffprobe", [
    "-v", "error", "-show_entries",
    "format=duration:stream=index,codec_type,codec_name,pix_fmt:stream_tags:stream_disposition",
    "-of", "json", inputPath,
  ], { ...options, limitStderr: true });
  return parseProbeOutput(text);
}

export async function verifyRequiredEncoders(requiredEncoders, options = {}) {
  if (requiredEncoders.length === 0) return;
  const output = await runProcess(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-encoders"], options);
  const available = new Set(output.split(/\r?\n/).map((line) => line.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)\s/)?.[1]).filter(Boolean));
  const missing = requiredEncoders.filter((encoder) => !available.has(encoder));
  if (missing.length) throw new Error(`FFmpeg 缺少所需编码器：${missing.join("、")}，请安装包含这些编码器的 FFmpeg`);
}

export async function executeConversion({ inputPath, outputPath, media, plan }, options = {}) {
  const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp.mp4`);
  let failure, published = false;
  let partial = "", seconds = 0;
  try {
    await runProcess(options.ffmpeg ?? "ffmpeg", plan.buildArguments({ inputPath, temporaryPath }), {
      ...options,
      forwardSignals: true,
      onStdout(chunk) {
        partial += chunk.toString("utf8");
        const lines = partial.split("\n"); partial = lines.pop();
        for (const line of lines) {
          const [key, value] = line.trim().split("=");
          if (/^out_time_(ms|us)$/.test(key) && Number.isFinite(Number(value))) seconds = Number(value) / 1_000_000;
          if (key === "progress") {
            options.onProgress?.(media.durationSeconds
              ? `进度：${Math.min(100, Math.max(0, Math.trunc(seconds / media.durationSeconds * 100)))}%`
              : `已处理：${Math.max(0, seconds).toFixed(1)} 秒`);
          }
        }
        if (partial.length > 16 * 1024) throw new Error("FFmpeg 进度行超过大小限制");
      },
    });
    let temporaryFile;
    try { temporaryFile = await lstat(temporaryPath); }
    catch (error) { throw new Error(`FFmpeg 未生成普通临时文件 ${temporaryPath}：${error.message}`); }
    if (!temporaryFile.isFile()) throw new Error(`FFmpeg 未生成普通临时文件：${temporaryPath}`);
    try { await link(temporaryPath, outputPath); published = true; }
    catch (error) {
      throw new Error(error.code === "EEXIST" ? `目标已存在：${outputPath}` : `无法发布输出：${error.message}`);
    }
  } catch (error) { failure = error; }
  finally {
    try { await unlink(temporaryPath); }
    catch (error) {
      if (error.code !== "ENOENT") {
        const cleanup = `${published ? "最终文件已完整发布；" : ""}无法清理临时文件，可安全手动删除 ${temporaryPath}：${error.message}`;
        failure = new Error(failure ? `${failure.message}\n${cleanup}` : cleanup);
      }
    }
  }
  if (failure) throw failure;
  return outputPath;
}
