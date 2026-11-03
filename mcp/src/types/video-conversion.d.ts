// 此文件为视频转换模块的类型声明；重新生成或覆盖声明时可能丢失这些注释。
declare namespace VideoConversion {
  // 描述探测或规划转换时的媒体轨道。
  interface Track {
    index: number;
    type?: string | null;
    codec: string | null;
    pixelFormat?: string | null;
    tags?: Record<string, unknown>;
    disposition?: Record<string, unknown>;
    attachedPic?: boolean;
  }
  // 描述探测得到的视频、音轨、字幕和时长。
  interface Media {
    durationSeconds: number | null;
    video: Track;
    audio: Track[];
    subtitles: Track[];
  }
  // 描述转换计划中单条轨道的处理方式。
  interface PlannedTrack extends Track { mode: 'copy' | 'transcode'; encoder: string }
  // 描述转换时所需轨道映射、编码器和命令参数。
  interface Plan {
    maps: string[];
    video: PlannedTrack;
    audio: PlannedTrack[];
    subtitles: PlannedTrack[];
    requiredEncoders: string[];
    // 启动转换进程前根据输入输出路径构造参数。
    buildArguments(paths: { inputPath: string; temporaryPath: string; progressTarget?: string }): string[];
  }
  // 描述执行转换所需的输入、输出与计划。
  interface Conversion { inputPath: string; outputPath: string; media: Media; plan: Plan }
  // 描述媒体子进程可选命令、环境和进度回调。
  interface ProcessOptions {
    ffprobe?: string;
    ffmpeg?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    onProgress?: (message: string) => void;
  }
}
// 为 MCP 复用根目录媒体子进程工具提供跨模块声明，约束探测、编码器检查与执行调用。
declare module '*video-conversion/execute.mjs' {
  // 探测媒体时运行探测程序并返回轨道信息。
  export function probeMedia(path: string, options?: VideoConversion.ProcessOptions): Promise<VideoConversion.Media>;
  // 执行转换前确认所需编码器可用。
  export function verifyRequiredEncoders(encoders: string[], options?: VideoConversion.ProcessOptions): Promise<void>;
  // 按计划运行转换进程并返回输出路径。
  export function executeConversion(conversion: VideoConversion.Conversion, options?: VideoConversion.ProcessOptions): Promise<string>;
}
// 为 MCP 检查兼容性及规划转换提供根目录规划模块的类型边界。
declare module '*video-conversion/plan.mjs' {
  // 根据探测结果生成转换计划。
  export function buildConversionPlan(media: VideoConversion.Media): VideoConversion.Plan;
  export const IMAGE_SUBTITLE_CODECS: Set<string>;
}
