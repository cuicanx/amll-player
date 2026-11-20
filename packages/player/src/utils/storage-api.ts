import { invoke } from "@tauri-apps/api/core";

export interface StorageUsage {
	totalBytes: number;
	cacheBytes: number;
	logBytes: number;
	musicCacheBytes: number;
	fileCount: number;
}

export interface StorageCleanResult {
	deletedFiles: number;
	freedBytes: number;
	errors: string[];
}

export function getStorageUsage(): Promise<StorageUsage> {
	return invoke("storage_usage");
}

export function cleanStorage(options: {
	cleanCovers: boolean;
	cleanLogs: boolean;
	cleanMusicCache: boolean;
}): Promise<StorageCleanResult> {
	return invoke("storage_clean", options);
}

export type LogLevel = "debug" | "normal" | "off";

export function setLogLevel(level: LogLevel): Promise<string> {
	return invoke("set_log_level", { level });
}

/** Human-readable size, using binary units (the OS also reports MiB). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
	return `${value.toFixed(digits)} ${units[unit]}`;
}
