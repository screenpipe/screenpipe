"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Search, X, Loader2, Clock, MessageSquare, User, ArrowLeft, Mic, Volume2, Hash, Tag } from "lucide-react";
import { useKeywordSearchStore, SearchMatch } from "@/lib/hooks/use-keyword-search-store";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { format, isToday, isYesterday } from "date-fns";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/utils/tauri";
import { emit } from "@tauri-apps/api/event";

interface SpeakerResult {
  id: number;
  name: string;
  metadata: string;
}

interface AudioTranscription {
  timestamp: string;
  transcription: string;
  device_name: string;
  is_input: boolean;
  speaker_name: string;
  duration_secs: number;
}


interface TaggedFrame {
  frame_id: number;
  timestamp: string;
  tag_names: string[];
  app_name: string;
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToTimestamp: (timestamp: string) => void;
  embedded?: boolean;
}

// stopwords to filter out from suggestions
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "this", "that", "was", "are",
  "be", "has", "had", "have", "not", "no", "do", "does", "did", "will",
  "can", "could", "would", "should", "may", "might", "shall", "if", "so",
  "as", "he", "she", "we", "they", "you", "i", "my", "your", "his", "her",
  "its", "our", "their", "me", "him", "us", "them", "am", "been", "being",
  "were", "what", "which", "who", "whom", "when", "where", "why", "how",
  "all", "each", "every", "both", "few", "more", "most", "other", "some",
  "such", "than", "too", "very", "just", "about", "above", "after", "again",
  "also", "any", "because", "before", "between", "here", "there", "then",
  "these", "those", "through", "under", "until", "while", "into", "over",
  "only", "own", "same", "still", "up", "out", "off", "down", "now", "new",
  "one", "two", "first", "last", "long", "great", "little", "right", "old",
  "big", "high", "small", "large", "next", "early", "young", "important",
  "public", "bad", "com", "www", "http", "https", "html", "css", "div",
  "span", "class", "true", "false", "null", "undefined", "var", "let",
  "const", "function", "return", "import", "export", "default", "type",
  "interface", "string", "number", "boolean", "object", "array", "void",
  "png", "jpg", "svg", "gif", "pdf", "tsx", "jsx", "src", "img", "alt",
  "width", "height", "style", "font", "size", "color", "text", "data",
  "value", "name", "index", "item", "list", "page", "file", "path",
  "error", "log", "get", "set", "app", "use", "end", "start", "time",
  "date", "day", "year", "month", "week", "like", "make", "know", "take",
  "come", "see", "look", "find", "give", "tell", "think", "say", "help",
  "show", "try", "ask", "need", "feel", "become", "leave", "put", "mean",
  "keep", "let", "begin", "seem", "talk", "turn", "hand", "run", "move",
  "play", "back", "way", "home", "work", "even", "good", "much", "well",
  "part", "made", "got", "going", "went", "done", "said", "line", "click",
  "button", "menu", "view", "open", "close", "save", "edit", "delete",
  "copy", "paste", "select", "search", "enter", "tab", "window", "screen",
]);

function isGarbageWord(word: string): boolean {
  if (word.length < 3 || word.length > 25) return true;
  // too many consonants in a row = OCR garbage
  if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(word)) return true;
  // pure numbers
  if (/^\d+$/.test(word)) return true;
  // numbers mixed with letters (like "h3" "x11" etc)
  if (/\d/.test(word) && /[a-z]/i.test(word) && word.length < 6) return true;
  // repeated chars
  if (/(.)\1{3,}/.test(word)) return true;
  // common file extensions / code tokens
  if (/^\.(js|ts|py|rs|md|json|yaml|toml|lock|env|cfg)$/i.test(word)) return true;
  return false;
}

// words that are proper nouns (Capitalized in original text) are more interesting
function extractInterestingWords(text: string): Map<string, { count: number; original: string }> {
  const words = new Map<string, { count: number; original: string }>();
  // split on whitespace/punctuation but preserve original casing
  const tokens = text.match(/[A-Za-z][a-z]{2,24}/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (isGarbageWord(lower)) continue;
    const existing = words.get(lower);
    if (existing) {
      existing.count++;
      // prefer the Capitalized version
      if (token[0] === token[0].toUpperCase() && token.slice(1) === token.slice(1).toLowerCase()) {
        existing.original = token;
      }
    } else {
      words.set(lower, { count: 1, original: token });
    }
  }
  return words;
}

function useSuggestions(isOpen: boolean) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const endTime = new Date(now.getTime() - 60_000);

        const params = new URLSearchParams({
          content_type: "ocr",
          limit: "100",
          offset: "0",
          start_time: oneDayAgo.toISOString(),
          end_time: endTime.toISOString(),
        });

        const resp = await fetch(`http://localhost:3030/search?${params}`);
        if (!resp.ok || cancelled) return;

        const data = await resp.json();
        const items = data?.data || [];

        // collect app names (used as fallback suggestions)
        const appNameCounts = new Map<string, { count: number; original: string }>();
        const allWords = new Map<string, { count: number; original: string }>();

        for (const item of items) {
          const content = item?.content || {};
          const appName = (content.app_name || "").trim();
          if (appName) {
            const lower = appName.toLowerCase();
            const existing = appNameCounts.get(lower);
            if (existing) {
              existing.count++;
            } else {
              appNameCounts.set(lower, { count: 1, original: appName });
            }
          }

          const text = content.text || "";
          const extracted = extractInterestingWords(text);
          for (const [lower, info] of extracted) {
            const existing = allWords.get(lower);
            if (existing) {
              existing.count += info.count;
              if (info.original[0] === info.original[0].toUpperCase()) {
                existing.original = info.original;
              }
            } else {
              allWords.set(lower, { ...info });
            }
          }
        }

        if (cancelled) return;

        const appNameSet = new Set(appNameCounts.keys());

        // filter keywords: exclude app names, not too frequent (UI chrome)
        const maxCount = Math.max(items.length * 0.6, 5);
        const candidates = [...allWords.entries()]
          .filter(([lower]) => !appNameSet.has(lower))
          .filter(([, info]) => info.count >= 1 && info.count < maxCount)
          .sort((a, b) => {
            const aProper = a[1].original[0] === a[1].original[0].toUpperCase() ? 1 : 0;
            const bProper = b[1].original[0] === b[1].original[0].toUpperCase() ? 1 : 0;
            if (bProper !== aProper) return bProper - aProper;
            return b[1].count - a[1].count;
          });

        // take top 20 then randomly pick 8 for variety
        const topPool = candidates.slice(0, 20);
        const shuffled = topPool.sort(() => Math.random() - 0.5);
        let picked = shuffled.slice(0, 8).map(([, info]) => info.original);

        // fallback: if we got fewer than 4 keyword suggestions, fill with app names
        if (picked.length < 4 && appNameCounts.size > 0) {
          const topApps = [...appNameCounts.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 8 - picked.length)
            .map(([, info]) => info.original);
          picked = [...picked, ...topApps];
        }

        if (!cancelled) {
          setSuggestions(picked);
          setIsLoading(false);
        }
      } catch {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return { suggestions, isLoading };
}

// Frame thumbnail component with loading state
const FrameThumbnail = ({ frameId, alt }: { frameId: number; alt: string }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  return (
    <div className="aspect-video bg-muted relative overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {hasError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <span className="text-xs text-muted-foreground">unavailable</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`http://localhost:3030/frames/${frameId}`}
          alt={alt}
          className={cn(
            "w-full h-full object-cover transition-opacity",
            isLoading ? "opacity-0" : "opacity-100"
          )}
          loading="lazy"
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
        />
      )}
    </div>
  );
};

// Format relative time
function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const time = format(date, "h:mm a");
  if (isToday(date)) return time;
  if (isYesterday(date)) return `yesterday ${time}`;
  return format(date, "MMM d") + " " + time;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) return <>{text}</>;
  const escaped = escapeRegExp(query.trim());
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.trim().toLowerCase() ? (
          <mark key={i} className="bg-yellow-400/50 text-inherit rounded-sm px-0.5 font-semibold">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

// Overlay highlight on top of a frame thumbnail image
const FrameThumbnailWithHighlight = ({
  frameId,
  alt,
  query,
  ocrText,
}: {
  frameId: number;
  alt: string;
  query?: string;
  ocrText?: string;
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const hasMatch = !!(query && ocrText && ocrText.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="aspect-video bg-muted relative overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {hasError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <span className="text-xs text-muted-foreground">unavailable</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`http://localhost:3030/frames/${frameId}`}
          alt={alt}
          className={cn(
            "w-full h-full object-cover transition-opacity",
            isLoading ? "opacity-0" : "opacity-100"
          )}
          loading="lazy"
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setHasError(true);
          }}
        />
      )}
      {/* Keyword-found badge overlay */}
      {hasMatch && !isLoading && !hasError