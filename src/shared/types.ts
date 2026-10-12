export type MediaType = 'image' | 'video';

/** Where a media URL was discovered on the page. */
export type MediaSource = 'img' | 'css-background' | 'video' | 'css-file' | 'network';

export interface FoundImage {
  url: string;
  source: MediaSource;
  width: number | null;
  height: number | null;
  alt: string;
  /** data-mg-id of the DOM element (for hover highlight), when known. */
  mgId?: string;
}

export interface FoundVideo {
  url: string;
  source: MediaSource;
  width: number | null;
  height: number | null;
  /** true when width/height is the element's on-screen box, not the real video size. */
  approxSize?: boolean;
  poster: string | null;
  duration: number | null;
  isBlob: boolean;
  mgId?: string;
}

export interface ScanData {
  pageUrl: string;
  pageTitle: string;
  images: FoundImage[];
  videos: FoundVideo[];
  /** Cross-origin stylesheets the page could not read — fetched by the background. */
  externalSheets: string[];
}

/** Minimal description of a file to download, as passed popup → background. */
export interface DownloadItem {
  url: string;
  type: MediaType;
  mime?: string | null;
}

export interface DownloadResult {
  url: string;
  ok: boolean;
  error?: string;
  downloadId?: number;
  native?: boolean;
}

export type DownloadMode = 'downloads' | 'zip' | 'directory';
export type ThemeSetting = 'system' | 'light' | 'dark';
export type LangSetting = 'auto' | 'ru' | 'en' | 'uk';

export interface Settings {
  mg_download_mode: DownloadMode;
  mg_subfolder: string;
  mg_lang: LangSetting;
  mg_theme: ThemeSetting;
}

/** Error code used across content/background/UI for blobs the browser won't hand over (MSE streams). */
export const STREAM_UNAVAILABLE = 'stream-unavailable';

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
