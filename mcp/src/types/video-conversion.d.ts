declare namespace VideoConversion {
  interface Track {
    index: number;
    type?: string | null;
    codec: string | null;
    pixelFormat?: string | null;
    tags?: Record<string, unknown>;
    disposition?: Record<string, unknown>;
    attachedPic?: boolean;
  }
  interface Media {
    durationSeconds: number | null;
    video: Track;
    audio: Track[];
    subtitles: Track[];
  }
  interface PlannedTrack extends Track { mode: 'copy' | 'transcode'; encoder: string }
  interface Plan {
    maps: string[];
    video: PlannedTrack;
    audio: PlannedTrack[];
    subtitles: PlannedTrack[];
    requiredEncoders: string[];
    buildArguments(paths: { inputPath: string; temporaryPath: string; progressTarget?: string }): string[];
  }
  interface Conversion { inputPath: string; outputPath: string; media: Media; plan: Plan }
  interface ProcessOptions {
    ffprobe?: string;
    ffmpeg?: string;
    env?: NodeJS.ProcessEnv;
    maxOutputBytes?: number;
    onProgress?: (message: string) => void;
  }
}
declare module '*video-conversion/execute.mjs' {
  export function probeMedia(path: string, options?: VideoConversion.ProcessOptions): Promise<VideoConversion.Media>;
  export function verifyRequiredEncoders(encoders: string[], options?: VideoConversion.ProcessOptions): Promise<void>;
  export function executeConversion(conversion: VideoConversion.Conversion, options?: VideoConversion.ProcessOptions): Promise<string>;
}
declare module '*video-conversion/plan.mjs' {
  export function buildConversionPlan(media: VideoConversion.Media): VideoConversion.Plan;
  export const IMAGE_SUBTITLE_CODECS: Set<string>;
}
