// ============================================================================
// Shared chat utilities - mention parsing, shortcut formatting, app suggestions
// ============================================================================

// ============================================================================
// SHORTCUT FORMATTING - Consistent modifier ordering (⌘ → ⌃ → ⌥ → ⇧ → key)
// ============================================================================

/**
 * Format a shortcut string for display with consistent modifier ordering.
 * On macOS: Command (⌘) → Control (⌃) → Option (⌥) → Shift (⇧) → Key
 * On Windows/Linux: Ctrl → Alt → Shift → Key
 */
export function formatShortcutDisplay(shortcut: string, isMac: boolean): string {
  if (!shortcut) return "";

  // Parse the shortcut into parts
  const parts = shortcut.split("+").map(p => p.trim().toLowerCase());

  // Define modifier priorities (lower = comes first)
  const modifierPriority: Record<string, number> = {
    "super": 0, "command": 0, "cmd": 0,
    "ctrl": 1, "control": 1,
    "alt": 2, "option": 2,
    "shift": 3,
  };

  // Separate modifiers from the key
  const modifiers: string[] = [];
  let key = "";

  for (const part of parts) {
    if (modifierPriority[part] !== undefined) {
      modifiers.push(part);
    } else {
      key = part;
    }
  }

  // Sort modifiers by priority
  modifiers.sort((a, b) => (modifierPriority[a] ?? 99) - (modifierPriority[b] ?? 99));

  if (isMac) {
    // Convert to Mac symbols
    const macSymbols: Record<string, string> = {
      "super": "⌘", "command": "⌘", "cmd": "⌘",
      "ctrl": "⌃", "control": "⌃",
      "alt": "⌥", "option": "⌥",
      "shift": "⇧",
    };
    const formattedMods = modifiers.map(m => macSymbols[m] || m).join("");
    return formattedMods + key.toUpperCase();
  } else {
    // Windows/Linux: readable format
    const winNames: Record<string, string> = {
      "super": "Win", "command": "Ctrl", "cmd": "Ctrl",
      "ctrl": "Ctrl", "control": "Ctrl",
      "alt": "Alt", "option": "Alt",
      "shift": "Shift",
    };
    const formattedMods = modifiers.map(m => winNames[m] || m);
    return [...formattedMods, key.toUpperCase()].join("+");
  }
}

// ============================================================================
// @MENTION SYSTEM - Time, Content Type, and App filters
// ============================================================================

interface TimeRange {
  start: Date;
  end: Date;
  label: string;
}

export interface ParsedMentions {
  cleanedInput: string;
  timeRanges: TimeRange[];
  contentType: "all" | "ocr" | "audio" | "input" | "accessibility" | null;
  appName: string | null;
  usedSelection: boolean;
  speakerName: string | null;
}

export interface ParseMentionsOptions {
  selectionRange?: { start: Date; end: Date } | null;
  appTagMap?: Record<string, string>;
}

// Common app name mappings (user-friendly -> actual app name patterns)
const APP_MAPPINGS: Record<string, string[]> = {
  "chrome": ["Google Chrome", "Chrome"],
  "slack": ["Slack"],
  "vscode": ["Code", "Visual Studio Code"],
  "code": ["Code", "Visual Studio Code"],
  "terminal": ["Terminal", "iTerm", "iTerm2", "Warp", "Alacritty", "kitty"],
  "zoom": ["zoom.us", "Zoom"],
  "teams": ["Microsoft Teams", "Teams"],
  "discord": ["Discord"],
  "figma": ["Figma"],
  "notion": ["Notion"],
  "obsidian": ["Obsidian"],
  "safari": ["Safari"],
  "firefox": ["Firefox"],
  "arc": ["Arc"],
  "cursor": ["Cursor"],
  "finder": ["Finder"],
  "mail": ["Mail"],
  "messages": ["Messages"],
  "spotify": ["Spotify"],
  "twitter": ["Twitter", "X"],
  "x": ["Twitter", "X"],
  "linear": ["Linear"],
  "github": ["GitHub Desktop"],
  "postman": ["Postman"],
  "iterm": ["iTerm", "iTerm2"],
  "warp": ["Warp"],
};

export function parseMentions(input: string, options?: ParseMentionsOptions): ParsedMentions {
  const now = new Date();
  const timeRanges: TimeRange[] = [];
  let cleanedInput = input;
  let contentType: "all" | "ocr" | "audio" | "input" | "accessibility" | null = null;
  let appName: string | null = null;
  let usedSelection = false;
  let speakerName: string | null = null;

  // === TIME MENTIONS ===

  // @selection - timeline selection
  const selectionPattern = /@selection\b/gi;
  if (selectionPattern.test(cleanedInput) && options?.selectionRange) {
    timeRanges.push({
      start: options.selectionRange.start,
      end: options.selectionRange.end,
      label: "selected range",
    });
    cleanedInput = cleanedInput.replace(selectionPattern, "").trim();
    usedSelection = true;
  }

  const timePatterns: { pattern: RegExp; getRange: () => TimeRange }[] = [
    {
      pattern: /@today\b/gi,
      getRange: () => {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        return { start, end: now, label: "today" };
      },
    },
    {
      pattern: /@yesterday\b/gi,
      getRange: () => {
        const start = new Date(now);
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setHours(23, 59, 59, 999);
        return { start, end, label: "yesterday" };
      },
    },
    {
      pattern: /@last[- ]?week\b/gi,
      getRange: () => {
        const start = new Date(now);
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        return { start, end: now, label: "last week" };
      },
    },
    {
      pattern: /@this[- ]?morning\b/gi,
      getRange: () => {
        const start = new Date(now);
        start.setHours(6, 0, 0, 0);
        const end = new Date(now);
        end.setHours(12, 0, 0, 0);
        return { start, end: now < end ? now : end, label: "this morning" };
      },
    },
    {
      pattern: /@last[- ]?hour\b/gi,
      getRange: () => {
        const start = new Date(now.getTime() - 60 * 60 * 1000);
        return { start, end: now, label: "last hour" };
      },
    },
  ];

  for (const { pattern, getRange } of timePatterns) {
    if (pattern.test(cleanedInput)) {
      timeRanges.push(getRange());
      cleanedInput = cleanedInput.replace(pattern, "").trim();
    }
  }

  // === CONTENT TYPE MENTIONS ===

  // @audio - audio transcriptions only
  const audioPattern = /@audio\b/gi;
  if (audioPattern.test(cleanedInput)) {
    contentType = "audio";
    cleanedInput = cleanedInput.replace(audioPattern, "").trim();
  }

  // @screen or @ocr or @vision - screen text only
  const screenPattern = /@(screen|ocr|vision)\b/gi;
  if (screenPattern.test(cleanedInput)) {
    contentType = "ocr";
    cleanedInput = cleanedInput.replace(screenPattern, "").trim();
  }

  // @input or @clicks or @events - UI events (clicks, keystrokes, app switches)
  const inputPattern = /@(input|clicks|events)\b/gi;
  if (inputPattern.test(cleanedInput)) {
    contentType = "input";
    cleanedInput = cleanedInput.replace(inputPattern, "").trim();
  }

  // === APP MENTIONS ===

  const appTagMap = options?.appTagMap || {};
  const appTagEntries = Object.entries(appTagMap);

  // Check for dynamic @appname patterns from autocomplete
  for (const [tag, actualName] of appTagEntries) {
    const appPattern = new RegExp(`@${tag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi");
    if (appPattern.test(cleanedInput)) {
      appName = actualName;
      cleanedInput = cleanedInput.replace(appPattern, "").trim();
      break;
    }
  }

  // Check for @appname patterns (common aliases)
  if (!appName) {
    for (const [shortName, actualNames] of Object.entries(APP_MAPPINGS)) {
      const appPattern = new RegExp(`@${shortName}\\b`, "gi");
      if (appPattern.test(cleanedInput)) {
        appName = actualNames[0]; // Use first (primary) name
        cleanedInput = cleanedInput.replace(appPattern, "").trim();
        break; // Only match first app
      }
    }
  }

  // === SPEAKER MENTIONS ===
  // Match @speaker:Name or just a capitalized name after @ that isn't a known tag
  // Pattern: @Name or @"Full Name" (quoted for multi-word names)
  const quotedSpeakerPattern = /@"([^"]+)"/g;
  const quotedMatch = quotedSpeakerPattern.exec(cleanedInput);
  if (quotedMatch) {
    speakerName = quotedMatch[1].trim();
    cleanedInput = cleanedInput.replace(quotedMatch[0], "").trim();
  } else {
    // Match @CapitalizedName (single word, must start with capital to distinguish from app tags)
    const simpleSpeakerPattern = /@([A-Z][a-zA-Z]+)(?:\s|$|,)/;
    const simpleMatch = simpleSpeakerPattern.exec(cleanedInput);
    if (simpleMatch) {
      const potentialName = simpleMatch[1];
      // Check if it's not a known app or time tag
      const knownTags = [
        "today", "yesterday", "selection", "audio", "screen", "ocr",
        ...Object.keys(APP_MAPPINGS).map(k => k.toLowerCase()),
        ...Object.keys(appTagMap).map(k => k.toLowerCase()),
      ];
      if (!knownTags.includes(potentialName.toLowerCase())) {
        speakerName = potentialName;
        cleanedInput = cleanedInput.replace(`@${potentialName}`, "").trim();
      }
    }
  }

  return { cleanedInput, timeRanges, contentType, appName, usedSelection, speakerName };
}

// ============================================================================
// MENTION SUGGESTIONS for autocomplete dropdown
// ============================================================================

export interface MentionSuggestion {
  tag: string;
  description: string;
  category: "time" | "content" | "app" | "speaker";
  appName?: string;
}

type AppAutocompleteItem = {
  name: string;
  count: number;
};

export function normalizeAppTag(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return base || "app";
}

export function buildAppMentionSuggestions(
  items: AppAutocompleteItem[],
  limit: number
): MentionSuggestion[] {
  const usedTags = new Set<string>();
  return items.slice(0, limit).map((item) => {
    const baseTag = normalizeAppTag(item.name);
    let tag = baseTag;
    let suffix = 2;
    while (usedTags.has(tag)) {
      tag = `${baseTag}${suffix}`;
      suffix += 1;
    }
    usedTags.add(tag);
    return {
      tag: `@${tag}`,
      description: item.name,
      category: "app" as const,
      appName: item.name,
    };
  });
}
