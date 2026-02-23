import { stat } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { twMerge } from "tailwind-merge";
import { ContentItem } from "@screenpipe/js";
import { clsx, type ClassValue } from "clsx";
import levenshtein from "js-levenshtein";
import {
	createSerializer,
	inferParserType,
	parseAsArrayOf,
	parseAsIsoDateTime,
	parseAsString,
} from "nuqs";


export type FlattenObjectKeys<
  T extends Record<string, unknown>,
  Key = keyof T
> = Key extends string
  ? T[Key] extends Record<string, unknown> | undefined
    ? `${Key}.${FlattenObjectKeys<NonNullable<T[Key]>>}`
    : `${Key}`
  : never;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
// Add this function to your existing utils.ts file
export function stripAnsiCodes(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[JKmsu]/g, "");
}
export function toCamelCase(str: string): string {
  return str.replace(/([-_][a-z])/g, (group) =>
    group.toUpperCase().replace("-", "").replace("_", "")
  );
}

export function keysToCamelCase<T>(obj: any): T {
  if (Array.isArray(obj)) {
    return obj.map((v) => keysToCamelCase<T>(v)) as any;
  } else if (obj !== null && obj.constructor === Object) {
    return Object.keys(obj).reduce(
      (result, key) => ({
        ...result,
        [toCamelCase(key)]: keysToCamelCase(obj[key]),
      }),
      {}
    ) as T;
  }
  return obj;
}

export function encode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}
export const convertHtmlToMarkdown = (html: string) => {
  const convertedHtml = html.replace(
    /<img\s+(?:[^>]*?\s+)?src="([^"]*)"(?:\s+(?:[^>]*?\s+)?alt="([^"]*)")?\s*\/?>/g,
    (match, src, alt) => {
      return `![${alt || ""}](${src})`;
    }
  );
  return convertedHtml.replace(/<[^>]*>/g, "");
};

export function getCliPath() {
  const os = platform();
  switch (os) {
    case "windows":
      return "%LOCALAPPDATA%\\screenpipe\\screenpipe.exe";
    case "macos":
      return "/Applications/screenpipe.app/Contents/MacOS/screenpipe";
    case "linux":
      return "/usr/local/bin/screenpipe";
    default:
      return "screenpipe";
  }
}

export function parseKeyboardShortcut(shortcut: string): string {
  if (typeof window !== "undefined") {
    const os = platform();

    const uniqueKeys = new Set(
      shortcut
        .toLowerCase()
        .split("+")
        .map((key) => key.trim())
    );

    return Array.from(uniqueKeys)
      .map((key) => {
        if (key === "super" || key === "meta" || key === "command" || key === "cmd") {
          return os === "macos" ? "⌘" : "⊞";
        }
        if (key === "ctrl" || key === "control") return "⌃";
        if (key === "alt") return os === "macos" ? "⌥" : "Alt";
        if (key === "shift") return "⇧";
        return key.charAt(0).toUpperCase() + key.slice(1);
      })
      .join(" + ");
  }
  return "";
}


export async function getFileSize(filePath: string): Promise<number> {
  const { size } = await stat(filePath);

  return size;
}

// Helper functions to flatten/unflatten objects
export const flattenObject = (obj: any, prefix = ""): Record<string, any> => {
  return Object.keys(obj).reduce((acc: Record<string, any>, k: string) => {
    const pre = prefix.length ? prefix + "." : "";
    if (
      typeof obj[k] === "object" &&
      obj[k] !== null &&
      !Array.isArray(obj[k])
    ) {
      Object.assign(acc, flattenObject(obj[k], pre + k));
    } else {
      acc[pre + k] = obj[k];
    }
    return acc;
  }, {});
};

export const unflattenObject = (obj: Record<string, any>): any => {
  const result: any = {};
  for (const key in obj) {
    const keys = key.split(".");
    let current = result;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (i === keys.length - 1) {
        current[k] = obj[key];
      } else {
        current[k] = current[k] || {};
        current = current[k];
      }
    }
  }
  return result;
};


export const removeDuplicateSelections = (
	results: ContentItem[],
	selectedResults: Set<number>,
	similarityThreshold: number = 0.9,
): Set<number> => {
	const newSelectedResults = new Set<number>();
	const seenContents: string[] = [];

	const getSimilarity = (str1: string, str2: string): number => {
		const maxLength = Math.max(str1.length, str2.length);
		const distance = levenshtein(str1, str2);
		return 1 - distance / maxLength;
	};

	const isDuplicate = (content: string): boolean => {
		return seenContents.some(
			(seenContent) =>
				getSimilarity(content, seenContent) >= similarityThreshold,
		);
	};

	Array.from(selectedResults).forEach((index) => {
		const item = results[index];
		if (!item || !item.type) return;

		let content = "";
		if (item.type === "OCR") content = item.content.text;
		else if (item.type === "Audio") content = item.content.transcription;
		else if (item.type === "UI") content = item.content.text;

		if (!isDuplicate(content)) {
			seenContents.push(content);
			newSelectedResults.add(index);
		}
	});

	return newSelectedResults;
};

// App category definitions for semantic grayscale coloring
const APP_CATEGORIES: Record<string, string[]> = {
	// Browsers - darkest (most common, need clear distinction)
	browser: [
		'chrome', 'google chrome', 'firefox', 'safari', 'edge', 'microsoft edge',
		'brave', 'opera', 'vivaldi', 'arc', 'zen', 'orion', 'chromium'
	],
	// Development tools - dark gray
	dev: [
		'code', 'vs code', 'visual studio', 'cursor', 'terminal', 'iterm',
		'warp', 'xcode', 'android studio', 'intellij', 'webstorm', 'pycharm',
		'sublime', 'atom', 'vim', 'neovim', 'emacs', 'github', 'gitlab',
		'postman', 'insomnia', 'docker', 'figma', 'sketch', 'zed'
	],
	// Communication - medium gray
	communication: [
		'slack', 'discord', 'zoom', 'teams', 'microsoft teams', 'messages',
		'whatsapp', 'telegram', 'signal', 'skype', 'webex', 'meet', 'facetime',
		'mail', 'outlook', 'gmail', 'thunderbird', 'spark', 'notion', 'linear',
		'loom', 'around', 'gather'
	],
	// Media & Entertainment - light gray
	media: [
		'spotify', 'youtube', 'music', 'apple music', 'vlc', 'netflix', 'tv',
		'prime video', 'disney', 'hulu', 'twitch', 'podcasts', 'audible',
		'photos', 'preview', 'quicktime', 'iina', 'plex', 'mpv'
	],
	// Productivity - medium-light gray
	productivity: [
		'notes', 'obsidian', 'roam', 'bear', 'evernote', 'onenote',
		'word', 'excel', 'powerpoint', 'pages', 'numbers', 'keynote',
		'google docs', 'sheets', 'slides', 'calendar', 'reminders', 'todoist',
		'things', 'fantastical', 'craft', 'ulysses', 'ia writer'
	],
};

// Grayscale colors for each category (from dark to light)
const CATEGORY_COLORS: Record<string, string> = {
	browser: '#1a1a1a',      // Very dark - browsers are most common
	dev: '#3d3d3d',          // Dark gray - dev tools
	communication: '#666666', // Medium gray - communication
	productivity: '#8a8a8a',  // Medium-light - productivity
	media: '#ababab',        // Light gray - media
	other: '#cccccc',        // Lightest - unknown/other apps
};

// Get category for an app name
function getAppCategory(appName: string): string {
	const lowerName = appName.toLowerCase();
	for (const [category, apps] of Object.entries(APP_CATEGORIES)) {
		if (apps.some(app => lowerName.includes(app) || app.includes(lowerName))) {
			return category;
		}
	}
	return 'other';
}

// Get grayscale color based on app category
export function getAppCategoryColor(appName: string): string {
	const category = getAppCategory(appName);
	return CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
}

// Semantic grayscale coloring based on app category
export function stringToColor(str: string): string {
	return getAppCategoryColor(str);
}

export const queryParser = {
	query: parseAsString,
	start_time: parseAsIsoDateTime,
	end_time: parseAsIsoDateTime,
	apps: parseAsArrayOf(parseAsString),
};

export const querySerializer = createSerializer(queryParser);

export type QueryParser = inferParserType<typeof queryParser>;

// macOS permission status values
export type PermissionStatus = "granted" | "denied" | "notDetermined";

export interface MacOSPermissions {
  screenRecording: PermissionStatus;
  microphone: PermissionStatus;
  accessibility: PermissionStatus;
}

// Check if microphone permission is effectively granted on macOS
// macOS can return different states that should be treated as granted
export async function checkMicrophonePermission(): Promise<boolean> {
  const os = platform();
  if (os !== "macos") {
    return true; // Non-macOS platforms handle permissions differently
  }
  
  try {
    // Try to get the actual permission status from the backend
    const status = await invoke<string>("check_audio_permission");
    // Handle various "granted" states - macOS may return "authorized" or "granted"
    const grantedStates = ["granted", "authorized", "allowed", "true", "1"];
    return grantedStates.includes(status.toLowerCase());
  } catch (error) {
    console.error("Error checking microphone permission:", error);
    // If we can't check, assume it might be granted to avoid false negatives
    return true;
  }
}

// Normalize macOS permission status to a consistent format
export function normalizeMacOSPermissionStatus(status: string | boolean | number): PermissionStatus {
  if (typeof status === "boolean") {
    return status ? "granted" : "denied";
  }
  if (typeof status === "number") {
    // macOS AVAuthorizationStatus: 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized
    if (status === 3) return "granted";
    if (status === 0) return "notDetermined";
    return "denied";
  }
  
  const normalizedStatus = status.toLowerCase().trim();
  const grantedValues = ["granted", "authorized", "allowed", "yes", "true", "3"];
  const notDeterminedValues = ["notdetermined", "not_determined", "unknown", "0"];
  
  if (grantedValues.includes(normalizedStatus)) return "granted";
  if (notDeterminedValues.includes(normalizedStatus)) return "notDetermined";
  return "denied";
}

