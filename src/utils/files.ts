import type { DownloadItem } from '@/types/models';

export type FileType = 'archive' | 'video' | 'audio' | 'image' | 'document' | 'program' | 'torrent' | 'other';

const TYPES: [FileType, RegExp][] = [
  ['archive', /^(zip|rar|7z|gz|tgz|tar|bz2|xz|zst|iso|cab|lzh|arj|ace|sit|sitx|r\d{2}|z\d{2}|\d{3}|par2?)$/],
  ['video', /^(mp4|mkv|webm|avi|mov|wmv|flv|m4v|mpe?g|3gp|ts|ogv|m3u8|mpd)$/],
  ['audio', /^(mp3|m4a|aac|flac|wav|ogg|opus|wma|aif)$/],
  ['image', /^(jpe?g|png|gif|webp|bmp|tiff?|svg|avif|heic)$/],
  ['document', /^(pdf|docx?|xlsx?|pptx?|txt|rtf|odt|ods|epub|mobi|csv|md)$/],
  ['program', /^(exe|msi|msu|apk|dmg|deb|rpm|appimage|pkg|bin|img)$/],
  ['torrent', /^torrent$/],
];

export const FILE_TYPE_LABELS: Record<FileType, string> = {
  archive: 'Archives', video: 'Video', audio: 'Audio', image: 'Images', document: 'Documents', program: 'Programs', torrent: 'Torrents', other: 'Other',
};

export function extOf(name: string | undefined | null): string {
  const m = /\.([a-z0-9]{1,6})$/i.exec((name || '').split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

export function typeOfName(name: string): FileType {
  const ext = extOf(name);
  return TYPES.find(([, re]) => re.test(ext))?.[0] ?? 'other';
}

export function typeOfItem(it: Pick<DownloadItem, 'fileName' | 'kind'>): FileType {
  if (it.kind === 'torrent') return 'torrent';
  if (it.kind === 'ytdlp' || it.kind === 'hls' || it.kind === 'muxed') return extOf(it.fileName) === 'm4a' ? 'audio' : 'video';
  return typeOfName(it.fileName);
}

/** Video page, stream or a file with a video extension. */
export function isVideo(it: DownloadItem): boolean {
  return it.kind === 'ytdlp' || it.kind === 'hls' || it.kind === 'muxed' || typeOfName(it.fileName) === 'video';
}

export function isTorrent(it: DownloadItem): boolean {
  return it.kind === 'torrent';
}
