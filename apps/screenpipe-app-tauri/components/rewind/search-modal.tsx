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
        // Match the keyword search exclusion window (1 minute) so suggestions
        // only contain words from data that's already FTS-indexed. Previously
        // used `now` which meant suggestions showed words the keyword search
        // couldn't find yet (FTS indexer runs every 30s).
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

export function SearchModal({ isOpen, onClose, onNavigateToTimestamp, embedded = false }: SearchModalProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Speaker search state
  const [speakerResults, setSpeakerResults] = useState<SpeakerResult[]>([]);
  const [isSearchingSpeakers, setIsSearchingSpeakers] = useState(false);
  // Drill-down: selected speaker to show their transcriptions
  const [selectedSpeaker, setSelectedSpeaker] = useState<SpeakerResult | null>(null);
  const [speakerTranscriptions, setSpeakerTranscriptions] = useState<AudioTranscription[]>([]);
  const [isLoadingTranscriptions, setIsLoadingTranscriptions] = useState(false);
  const [selectedTranscriptionIndex, setSelectedTranscriptionIndex] = useState(0);
  const [transcriptionFrames, setTranscriptionFrames] = useState<Map<string, number>>(new Map());

  // Tag search state
  const [tagResults, setTagResults] = useState<TaggedFrame[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]); // distinct tags for autocomplete
  const [isSearchingTags, setIsSearchingTags] = useState(false);
  const isTagSearch = query.startsWith("#");
  const isPeopleSearch = query.startsWith("@");

  // App filter
  const [appFilter, setAppFilter] = useState<string | null>(null);

  // Pagination
  const [ocrOffset, setOcrOffset] = useState(0);
  const [hasMoreOcr, setHasMoreOcr] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [transcriptionOffset, setTranscriptionOffset] = useState(0);
  const [hasMoreTranscriptions, setHasMoreTranscriptions] = useState(true);
  const [isLoadingMoreTranscriptions, setIsLoadingMoreTranscriptions] = useState(false);

  const OCR_PAGE_SIZE = 24;
  const TRANSCRIPTION_PAGE_SIZE = 30;

  const debouncedQuery = useDebounce(query, 200);
  const { suggestions, isLoading: suggestionsLoading } = useSuggestions(isOpen);

  const {
    searchResults,
    searchGroups,
    isSearching,
    searchKeywords,
    resetSearch,
  } = useKeywordSearchStore();

  // Compute app distribution from results and filter
  const appCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of searchResults) {
      counts.set(r.app_name, (counts.get(r.app_name) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1]);
  }, [searchResults]);

  const filteredResults = useMemo(() => {
    if (!appFilter) return searchResults;
    return searchResults.filter(r => r.app_name === appFilter);
  }, [searchResults, appFilter]);

  const filteredGroups = useMemo(() => {
    if (!appFilter) return searchGroups;
    return searchGroups.filter(g => g.representative.app_name === appFilter);
  }, [searchGroups, appFilter]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedIndex(0);
      setQuery("");
      resetSearch();
      setAppFilter(null);
      setSpeakerResults([]);
      setTagResults([]);
      setAllTags([]);
      setSelectedSpeaker(null);
      setSpeakerTranscriptions([]);
      setSelectedTranscriptionIndex(0);
      setOcrOffset(0);
      setHasMoreOcr(true);
      setTranscriptionOffset(0);
      setHasMoreTranscriptions(true);

      // Focus after next frame. The panel is made key window on show,
      // but the global shortcut path also calls show_main_window first.
      // A small delay handles the case where make_key_window is still
      // propagating through the window server.
      const rafId = requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 80);

      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(timer);
      };
    }
  }, [isOpen, resetSearch]);

  // Perform search when query changes
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      resetSearch();
      setSpeakerResults([]);
      setTagResults([]);
      setAppFilter(null);
      return;
    }

    // Skip keyword search for # and @ queries (handled by dedicated effects)
    if (debouncedQuery.startsWith("#") || debouncedQuery.startsWith("@")) {
      resetSearch();
      setSpeakerResults([]);
      return;
    }

    setAppFilter(null);
    setTagResults([]);
    setOcrOffset(0);
    setHasMoreOcr(true);
    searchKeywords(debouncedQuery, {
      limit: OCR_PAGE_SIZE,
      offset: 0,
    });
  }, [debouncedQuery, searchKeywords, resetSearch]);

  // Search tags when query starts with #
  useEffect(() => {
    if (!debouncedQuery.startsWith("#")) {
      setTagResults([]);
      setAllTags([]);
      return;
    }

    const tagQuery = debouncedQuery.slice(1).trim().toLowerCase(); // strip #
    let cancelled = false;

    (async () => {
      setIsSearchingTags(true);
      try {
        // Fetch all distinct tags with counts from the tags + vision_tags tables
        const tagsResp = await fetch("http://localhost:3030/raw_sql", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "SELECT t.name, COUNT(vt.vision_id) as count FROM tags t JOIN vision_tags vt ON t.id = vt.tag_id GROUP BY t.id, t.name ORDER BY count DESC",
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (cancelled) return;
        const allDbTags: { name: string; count: number }[] = tagsResp.ok
          ? await tagsResp.json()
          : [];

        // Set autocomplete pills (filtered if user typed something after #)
        const tagNames = allDbTags.map(t => t.name);
        setAllTags(
          tagQuery.length > 0
            ? tagNames.filter(t => t.toLowerCase().includes(tagQuery))
            : tagNames
        );

        // Find tags that match the query
        const matched = tagQuery.length > 0
          ? allDbTags.filter(t => t.name.toLowerCase().includes(tagQuery))
          : allDbTags;

        if (matched.length > 0 && !cancelled) {
          // Fetch frames tagged with matching tags
          const inList = matched.map(t => `'${t.name.replace(/'/g, "''")}'`).join(",");
          const framesResp = await fetch("http://localhost:3030/raw_sql", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `SELECT f.id as frame_id, f.timestamp, f.app_name, GROUP_CONCAT(DISTINCT t.name) as tag_names FROM vision_tags vt JOIN frames f ON vt.vision_id = f.id JOIN tags t ON vt.tag_id = t.id WHERE t.name IN (${inList}) GROUP BY f.id ORDER BY f.timestamp DESC LIMIT 50`,
            }),
            signal: AbortSignal.timeout(5000),
          });

          if (cancelled) return;
          if (framesResp.ok) {
            const rows: { frame_id: number; timestamp: string; tag_names: string; app_name: string }[] = await framesResp.json();
            setTagResults(rows.map(r => ({
              frame_id: r.frame_id,
              timestamp: r.timestamp,
              tag_names: r.tag_names.split(","),
              app_name: r.app_name || "",
            })));
          }
        } else {
          setTagResults([]);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsSearchingTags(false);
      }
    })();

    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Search speakers — triggered by @query or normal text query (>= 2 chars)
  useEffect(() => {
    if (selectedSpeaker) {
      setSpeakerResults([]);
      return;
    }

    const isAtQuery = debouncedQuery.startsWith("@");
    const searchTerm = isAtQuery ? debouncedQuery.slice(1).trim() : debouncedQuery.trim();

    // For normal queries, require >= 2 chars; for @, show all speakers immediately
    if (!isAtQuery && (searchTerm.length < 2 || debouncedQuery.startsWith("#"))) {
      setSpeakerResults([]);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      setIsSearchingSpeakers(true);
      try {
        // For @ with no text, fetch all speakers; otherwise search by name
        const url = searchTerm.length > 0
          ? `http://localhost:3030/speakers/search?name=${encodeURIComponent(searchTerm)}`
          : `http://localhost:3030/speakers/search?name=`;
        const resp = await fetch(url, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
        });
        if (resp.ok && !cancelled) {
          const speakers: SpeakerResult[] = await resp.json();
          setSpeakerResults(speakers.filter(s => s.name).slice(0, isAtQuery ? 20 : 5));
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsSearchingSpeakers(false);
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [debouncedQuery, selectedSpeaker]);

  // Load transcriptions when a speaker is selected
  useEffect(() => {
    if (!selectedSpeaker) {
      setSpeakerTranscriptions([]);
      setTranscriptionFrames(new Map());
      setTranscriptionOffset(0);
      setHasMoreTranscriptions(true);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      setIsLoadingTranscriptions(true);
      try {
        const params = new URLSearchParams({
          content_type: "audio",
          speaker_name: selectedSpeaker.name,
          limit: "30",
          offset: "0",
        });
        const resp = await fetch(
          `http://localhost:3030/search?${params}`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }
        );
        if (resp.ok && !cancelled) {
          const data = await resp.json();
          const items: AudioTranscription[] = (data?.data || []).map((item: any) => ({
            timestamp: item.content?.timestamp || "",
            transcription: item.content?.transcription || "",
            device_name: item.content?.device_name || "",
            is_input: item.content?.is_input ?? true,
            speaker_name: item.content?.speaker_name || selectedSpeaker.name,
            duration_secs: item.content?.duration_secs || 0,
          }));
          if (items.length < TRANSCRIPTION_PAGE_SIZE) setHasMoreTranscriptions(false);
          setSpeakerTranscriptions(items);

          // Fetch nearest frame for each transcription timestamp (in parallel batches)
          const uniqueTimestamps = [...new Set(items.map(i => i.timestamp).filter(Boolean))];
          if (uniqueTimestamps.length > 0 && !cancelled) {
            try {
              const map = new Map<string, number>();
              // Batch fetch: find closest frame within ±30s for each timestamp
              const promises = uniqueTimestamps.map(async (ts) => {
                const d = new Date(ts);
                const lo = new Date(d.getTime() - 30_000).toISOString();
                const hi = new Date(d.getTime() + 30_000).toISOString();
                const escaped = ts.replace(/'/g, "''");
                const resp = await fetch("http://localhost:3030/raw_sql", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    query: `SELECT id as frame_id FROM frames WHERE timestamp >= '${lo}' AND timestamp <= '${hi}' ORDER BY ABS(julianday(timestamp) - julianday('${escaped}')) LIMIT 1`,
                  }),
                  signal: AbortSignal.timeout(3000),
                });
                if (resp.ok) {
                  const rows: { frame_id: number }[] = await resp.json();
                  if (rows.length > 0) map.set(ts, rows[0].frame_id);
                }
              });
              await Promise.all(promises);
              if (!cancelled) setTranscriptionFrames(map);
            } catch {
              // frames are optional, ignore errors
            }
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsLoadingTranscriptions(false);
      }
    })();

    return () => { cancelled = true; controller.abort(); };
  }, [selectedSpeaker]);

  // Send to AI handler
  const handleSendToAI = useCallback(async () => {
    const result = filteredResults[selectedIndex];
    if (!result) return;

    const context = `Context from search result:\n${result.app_name} - ${result.window_name}\nTime: ${format(new Date(result.timestamp), "PPpp")}\n\nText:\n${result.text || ""}`;

    // Close search modal first
    onClose();

    // Show chat window (it will overlay on top of timeline, not close it)
    await commands.showWindow("Chat");

    // Small delay to ensure chat window's React components are mounted and listening
    await new Promise(resolve => setTimeout(resolve, 150));

    // Emit prefill event with context and frame image
    await emit("chat-prefill", { context, frameId: result.frame_id });
  }, [filteredResults, selectedIndex, onClose]);

  // Handle going back from speaker drill-down
  const handleBackFromSpeaker = useCallback(() => {
    setSelectedSpeaker(null);
    setSpeakerTranscriptions([]);
    setSelectedTranscriptionIndex(0);
    setTranscriptionOffset(0);
    setHasMoreTranscriptions(true);
    // Re-focus the input
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Load more OCR results
  const loadMoreOcr = useCallback(() => {
    if (isLoadingMore || !hasMoreOcr || !debouncedQuery.trim()) return;
    setIsLoadingMore(true);
    const newOffset = ocrOffset + OCR_PAGE_SIZE;
    setOcrOffset(newOffset);
    searchKeywords(debouncedQuery, {
      limit: OCR_PAGE_SIZE,
      offset: newOffset,
    }).finally(() => setIsLoadingMore(false));
  }, [isLoadingMore, hasMoreOcr, debouncedQuery, ocrOffset, searchKeywords]);

  // Track if we got fewer results than page size (= no more pages)
  useEffect(() => {
    if (searchResults.length > 0 && searchResults.length < (ocrOffset + OCR_PAGE_SIZE)) {
      setHasMoreOcr(false);
    }
  }, [searchResults.length, ocrOffset]);

  // Load more speaker transcriptions
  const loadMoreTranscriptions = useCallback(async () => {
    if (isLoadingMoreTranscriptions || !hasMoreTranscriptions || !selectedSpeaker) return;
    setIsLoadingMoreTranscriptions(true);
    const newOffset = transcriptionOffset + TRANSCRIPTION_PAGE_SIZE;
    setTranscriptionOffset(newOffset);

    try {
      const params = new URLSearchParams({
        content_type: "audio",
        speaker_name: selectedSpeaker.name,
        limit: TRANSCRIPTION_PAGE_SIZE.toString(),
        offset: newOffset.toString(),
      });
      const resp = await fetch(
        `http://localhost:3030/search?${params}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (resp.ok) {
        const data = await resp.json();
        const items = (data?.data || []).map((item: any) => ({
          timestamp: item.content?.timestamp || "",
          transcription: item.content?.transcription || "",
          device_name: item.content?.device_name || "",
          is_input: item.content?.is_input ?? true,
          speaker_name: item.content?.speaker_name || selectedSpeaker.name,
          duration_secs: item.content?.duration_secs || 0,
        }));
        if (items.length < TRANSCRIPTION_PAGE_SIZE) setHasMoreTranscriptions(false);
        setSpeakerTranscriptions(prev => [...prev, ...items]);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingMoreTranscriptions(false);
    }
  }, [isLoadingMoreTranscriptions, hasMoreTranscriptions, selectedSpeaker, transcriptionOffset]);

  // Infinite scroll handler
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const target = e.currentTarget;
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 200;

    if (nearBottom) {
      if (selectedSpeaker) {
        loadMoreTranscriptions();
      } else {
        loadMoreOcr();
      }
    }
  }, [selectedSpeaker, loadMoreOcr, loadMoreTranscriptions]);

  // Keyboard navigation — skip arrow key capture when input is focused (let cursor move)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const inputFocused = document.activeElement === inputRef.current;

      // Speaker drill-down mode
      if (selectedSpeaker) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            handleBackFromSpeaker();
            break;
          case "ArrowDown":
            e.preventDefault();
            setSelectedTranscriptionIndex(i => Math.min(i + 1, speakerTranscriptions.length - 1));
            break;
          case "ArrowUp":
            e.preventDefault();
            setSelectedTranscriptionIndex(i => Math.max(i - 1, 0));
            break;
          case "Enter":
            e.preventDefault();
            if (speakerTranscriptions[selectedTranscriptionIndex]?.timestamp) {
              onNavigateToTimestamp(speakerTranscriptions[selectedTranscriptionIndex].timestamp);
              onClose();
            }
            break;
        }
        return;
      }

      // When input is focused, let left/right arrows move the cursor
      if (inputFocused && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        return; // Don't capture — let the input handle it
      }

      const cols = 4; // Grid columns

      switch (e.key) {
        case "Escape":
          onClose();
          break;
        case "ArrowRight":
          e.preventDefault();
          setSelectedIndex(i => Math.min(i + 1, filteredResults.length - 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
          setSelectedIndex(i => Math.max(i - 1, 0));
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex(i => Math.min(i + cols, filteredResults.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex(i => Math.max(i - cols, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) {
            // Cmd+Enter = send to AI
            handleSendToAI();
          } else if (filteredResults[selectedIndex]) {
            // Enter = navigate to timestamp
            onNavigateToTimestamp(filteredResults[selectedIndex].timestamp);
            onClose();
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, filteredResults, selectedIndex, selectedSpeaker, speakerTranscriptions, selectedTranscriptionIndex, onClose, onNavigateToTimestamp, handleSendToAI, handleBackFromSpeaker]);

  // Scroll selected item into view
  useEffect(() => {
    if (gridRef.current && filteredResults.length > 0) {
      const selectedEl = gridRef.current.querySelector(`[data-index="${selectedIndex}"]`);
      selectedEl?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, filteredResults.length]);

  const handleSelectResult = useCallback((result: SearchMatch) => {
    onNavigateToTimestamp(result.timestamp);
    onClose();
  }, [onNavigateToTimestamp, onClose]);

  if (!isOpen) return null;

  const hasResults = searchResults.length > 0 || speakerResults.length > 0 || tagResults.length > 0;
  const showEmpty = !isSearching && !isSearchingSpeakers && !isSearchingTags && debouncedQuery && !hasResults && !selectedSpeaker && !isTagSearch && !isPeopleSearch;
  const activeIndex = hoveredIndex ?? selectedIndex;

  const renderResults = () => (
    <>
      {/* === Speaker drill-down view === */}
      {selectedSpeaker ? (
        <div>
          {/* Back button + speaker name */}
          <button
            onClick={handleBackFromSpeaker}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <User className="w-3.5 h-3.5" />
            <span className="font-medium text-foreground">{selectedSpeaker.name}</span>
          </button>

          {isLoadingTranscriptions && (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-muted animate-pulse rounded p-3 h-16" />
              ))}
            </div>
          )}

          {!isLoadingTranscriptions && speakerTranscriptions.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              no transcriptions found for {selectedSpeaker.name}
            </div>
          )}

          {speakerTranscriptions.length > 0 && (
            <div className="grid grid-cols-4 gap-3">
              {speakerTranscriptions.map((t, index) => {
                const frameId = transcriptionFrames.get(t.timestamp);
                return (
                  <div
                    key={`${t.timestamp}-${index}`}
                    data-index={index}
                    onClick={() => {
                      if (t.timestamp) {
                        onNavigateToTimestamp(t.timestamp);
                        if (!embedded) onClose();
                      }
                    }}
                    className={cn(
                      "cursor-pointer rounded overflow-hidden border transition-all duration-150",
                      index === selectedTranscriptionIndex
                        ? "ring-2 ring-foreground border-foreground scale-[1.02] shadow-lg z-10"
                        : "border-border hover:border-foreground/50"
                    )}
                  >
                    {frameId ? (
                      <FrameThumbnail
                        frameId={frameId}
                        alt={t.transcription || t.speaker_name}
                      />
                    ) : (
                      <div className="aspect-video bg-muted flex items-center justify-center">
                        <Mic className="w-5 h-5 text-muted-foreground/40" />
                      </div>
                    )}
                    <div className="p-2 bg-card">
                      <p className="text-xs text-foreground line-clamp-2 leading-relaxed mb-1">
                        {t.transcription || "(empty)"}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3" />
                          {t.timestamp ? formatRelativeTime(t.timestamp) : "unknown"}
                        </span>
                        <span className="flex items-center gap-0.5">
                          {t.is_input ? <Mic className="w-2.5 h-2.5" /> : <Volume2 className="w-2.5 h-2.5" />}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Load more transcriptions indicator */}
          {speakerTranscriptions.length > 0 && (isLoadingMoreTranscriptions || hasMoreTranscriptions) && (
            <div className="flex justify-center py-4">
              {isLoadingMoreTranscriptions ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              ) : (
                <span className="text-xs text-muted-foreground">scroll for more</span>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Empty state */}
          {showEmpty && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              no results for &quot;{debouncedQuery}&quot;
            </div>
          )}

          {/* Tag autocomplete pills */}
          {isTagSearch && allTags.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                <Tag className="w-3 h-3" />
                tags
              </p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {allTags.map((t) => {
                  const tagQuery = query.slice(1).trim().toLowerCase();
                  const isActive = tagQuery === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setQuery(`#${t}`)}
                      className={cn(
                        "inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer",
                        isActive
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-foreground/70 hover:bg-muted hover:border-foreground/30"
                      )}
                    >
                      <Hash className="w-2.5 h-2.5" />
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tag timeline entries — thumbnail grid */}
          {isTagSearch && tagResults.length > 0 && (
            <div className="grid grid-cols-4 gap-3">
              {tagResults.map((frame) => (
                <div
                  key={frame.frame_id}
                  onClick={() => {
                    onNavigateToTimestamp(frame.timestamp);
                    if (!embedded) onClose();
                  }}
                  className="cursor-pointer rounded overflow-hidden border border-border hover:border-foreground/50 transition-all duration-150"
                >
                  <FrameThumbnail
                    frameId={frame.frame_id}
                    alt={frame.tag_names.join(", ")}
                  />
                  <div className="p-2 bg-card">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                      <Clock className="w-3 h-3" />
                      <span className="font-mono">
                        {formatRelativeTime(frame.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-foreground truncate">
                      {frame.app_name || frame.tag_names[0]}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {frame.tag_names.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 text-[10px] rounded-full bg-foreground/8 text-foreground/60"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Tag search loading */}
          {isTagSearch && isSearchingTags && tagResults.length === 0 && allTags.length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-muted animate-pulse rounded p-3 h-12" />
              ))}
            </div>
          )}

          {/* Tag search empty */}
          {isTagSearch && !isSearchingTags && tagResults.length === 0 && allTags.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {query.slice(1).trim()
                ? <>no tags matching &quot;{query.slice(1).trim()}&quot;</>
                : "no tags found"}
            </div>
          )}

          {/* @ people search loading */}
          {isPeopleSearch && isSearchingSpeakers && speakerResults.length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-muted animate-pulse rounded p-3 h-10" />
              ))}
            </div>
          )}

          {/* @ people search empty */}
          {isPeopleSearch && !isSearchingSpeakers && speakerResults.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {query.slice(1).trim()
                ? <>no people matching &quot;{query.slice(1).trim()}&quot;</>
                : "no speakers found"}
            </div>
          )}

          {/* Loading skeleton */}
          {!isTagSearch && !isPeopleSearch && isSearching && searchResults.length === 0 && speakerResults.length === 0 && (
            <div className="grid grid-cols-4 gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="bg-muted animate-pulse rounded overflow-hidden">
                  <div className="aspect-video" />
                  <div className="p-2 space-y-1">
                    <div className="h-3 bg-muted-foreground/20 rounded w-16" />
                    <div className="h-2 bg-muted-foreground/20 rounded w-24" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* People section */}
          {speakerResults.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                <User className="w-3 h-3" />
                people
              </p>
              <div className="flex gap-2 flex-wrap">
                {speakerResults.map((speaker) => (
                  <button
                    key={speaker.id}
                    onClick={() => {
                      setSelectedSpeaker(speaker);
                      setSelectedTranscriptionIndex(0);
                    }}
                    className="flex items-center gap-2 px-3 py-2 border border-border rounded-md
                      hover:bg-muted hover:border-foreground/30 transition-colors cursor-pointer"
                  >
                    <User className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{speaker.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Screen results grid */}
          {searchResults.length > 0 && (
            <>
              {speakerResults.length > 0 && (
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                  <Search className="w-3 h-3" />
                  screen
                </p>
              )}

              {/* App filter chips */}
              {appCounts.length > 1 && (
                <div className="flex gap-1.5 mb-3 flex-wrap">
                  <button
                    onClick={() => { setAppFilter(null); setSelectedIndex(0); }}
                    className={cn(
                      "px-2 py-0.5 text-[11px] rounded-full border transition-colors",
                      !appFilter
                        ? "bg-foreground text-background border-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/40"
                    )}
                  >
                    all ({searchResults.length})
                  </button>
                  {appCounts.map(([app, count]) => (
                    <button
                      key={app}
                      onClick={() => { setAppFilter(appFilter === app ? null : app); setSelectedIndex(0); }}
                      className={cn(
                        "px-2 py-0.5 text-[11px] rounded-full border transition-colors",
                        appFilter === app
                          ? "bg-foreground text-background border-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/40"
                      )}
                    >
                      {app} ({count})
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-4 gap-3">
                {filteredResults.map((result, index) => {
                  const isActive = index === activeIndex;
                  const group = filteredGroups[index];
                  const groupSize = group?.group_size ?? 1;

                  return (
                    <div
                      key={result.frame_id}
                      data-index={index}
                      onClick={() => handleSelectResult(result)}
                      onMouseEnter={() => setHoveredIndex(index)}
                      onMouseLeave={() => setHoveredIndex(null)}
                      className={cn(
                        "cursor-pointer rounded overflow-hidden border transition-all duration-150",
                        isActive
                          ? "ring-2 ring-foreground border-foreground scale-[1.02] shadow-lg z-10"
                          : "border-border hover:border-foreground/50"
                      )}
                    >
                      <div className="relative">
                        <FrameThumbnail
                          frameId={result.frame_id}
                          alt={`${result.app_name} - ${result.window_name}`}
                        />
                        {groupSize > 1 && (
                          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-medium bg-black/70 text-white rounded">
                            {groupSize} frames
                          </span>
                        )}
                      </div>
                      <div className="p-2 bg-card">
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                          <Clock className="w-3 h-3" />
                          <span className="font-mono">
                            {groupSize > 1 && group
                              ? `${formatRelativeTime(group.start_time)} – ${formatRelativeTime(group.end_time)}`
                              : formatRelativeTime(result.timestamp)}
                          </span>
                        </div>
                        <p className="text-xs font-medium text-foreground truncate">
                          {result.app_name}
                        </p>
                        {isActive && (
                          <div className="mt-1 pt-1 border-t border-border space-y-1">
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {result.window_name}
                            </p>
                            {result.url && (
                              <p className="text-xs text-muted-foreground/70 truncate">
                                {result.url}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Load more indicator */}
              {(isLoadingMore || (hasMoreOcr && searchResults.length >= OCR_PAGE_SIZE)) && (
                <div className="flex justify-center py-4">
                  {isLoadingMore ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-xs text-muted-foreground">scroll for more</span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Suggestions when no query */}
          {!debouncedQuery && !isSearching && (
            <div className="py-8 px-2">
              {suggestions.length > 0 ? (
                <>
                  <p className="text-xs text-muted-foreground mb-3 text-center">
                    from your recent activity
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => setQuery(suggestion)}
                        className="px-3 py-1.5 text-sm border border-border rounded-md
                          hover:bg-muted hover:border-foreground/30 transition-colors
                          text-foreground/80 hover:text-foreground cursor-pointer"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </>
              ) : suggestionsLoading ? (
                <div className="text-center text-sm text-muted-foreground">
                  loading suggestions...
                </div>
              ) : (
                <div className="text-center text-sm text-muted-foreground">
                  type to search your screen history
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="flex flex-col h-full bg-card">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedSpeaker) {
                setSelectedSpeaker(null);
                setSpeakerTranscriptions([]);
                setSelectedTranscriptionIndex(0);
                setTranscriptionOffset(0);
                setHasMoreTranscriptions(true);
              }
            }}
            placeholder="Search your memory... (# tags, @ people)"
            className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground text-sm outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
          {(isSearching || isSearchingTags) && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />}
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 hover:bg-muted rounded"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Results area — fills remaining space */}
        <div
          ref={gridRef}
          className="flex-1 min-h-0 overflow-y-auto p-4 overscroll-contain touch-pan-y"
          onScroll={handleScroll}
        >
          {renderResults()}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
          <div className="flex items-center gap-4">
            {selectedSpeaker ? (
              <>
                <span>↑↓ navigate</span>
                <span>⏎ go to timeline</span>
                <span>esc back</span>
              </>
            ) : (
              <>
                <span>←→↑↓ navigate</span>
                <span>⏎ go to timeline</span>
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  ⌘⏎ ask AI
                </span>
              </>
            )}
          </div>
          <span>esc {selectedSpeaker ? "back" : "close"}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] isolate"
      onWheel={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      onTouchMove={(e) => e.stopPropagation()}
    >
      {/* Backdrop - captures all pointer events to prevent interaction with timeline */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        onWheel={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onTouchMove={(e) => e.stopPropagation()}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl mx-4 bg-card border border-border shadow-2xl overflow-hidden rounded-lg isolate">
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Exit speaker drill-down when user edits search query
              if (selectedSpeaker) {
                setSelectedSpeaker(null);
                setSpeakerTranscriptions([]);
                setSelectedTranscriptionIndex(0);
                setTranscriptionOffset(0);
                setHasMoreTranscriptions(true);
              }
            }}
            placeholder="Search your memory... (# tags, @ people)"
            className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground text-sm outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
          />
          {(isSearching || isSearchingTags) && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />}
          {query && (
            <button
              onClick={() => setQuery("")}
              className="p-1 hover:bg-muted rounded"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Results area - isolate scroll to prevent timeline from scrolling */}
        <div
          ref={gridRef}
          className="max-h-[60vh] overflow-y-auto p-4 overscroll-contain touch-pan-y"
          onWheel={(e) => {
            e.stopPropagation();
            const target = e.currentTarget;
            const isAtTop = target.scrollTop === 0 && e.deltaY < 0;
            const isAtBottom = target.scrollTop + target.clientHeight >= target.scrollHeight && e.deltaY > 0;
            if (isAtTop || isAtBottom) e.preventDefault();
          }}
          onTouchMove={(e) => e.stopPropagation()}
          onScroll={handleScroll}
        >
          {renderResults()}
        </div>

        {/* Footer with keyboard hints */}
        <div className="px-4 py-2 border-t border-border bg-muted/30 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
          <div className="flex items-center gap-4">
            {selectedSpeaker ? (
              <>
                <span>↑↓ navigate</span>
                <span>⏎ go to timeline</span>
                <span>esc back</span>
              </>
            ) : (
              <>
                <span>←→↑↓ navigate</span>
                <span>⏎ go to timeline</span>
                <span className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  ⌘⏎ ask AI
                </span>
              </>
            )}
          </div>
          <span>esc {selectedSpeaker ? "back" : "close"}</span>
        </div>
      </div>
    </div>
  );
}
