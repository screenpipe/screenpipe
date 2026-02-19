"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  X,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { platform } from "@tauri-apps/plugin-os";
import { Command } from "@tauri-apps/plugin-shell";
import posthog from "posthog-js";

const API = "http://localhost:3030";

interface DailySummary {
  date: string; // YYYY-MM-DD
  generatedAt: string;
  timeBreakdown: { app: string; minutes: number }[];
  keyMoments: { time: string; description: string }[];
  actionItems: { text: string; urgency: "high" | "medium" | "low" }[];
  peopleMentioned: { name: string; context: string }[];
  oneLiner: string;
}

const SUMMARY_PROMPT = `Analyze this audio transcript data. Respond with ONLY a single valid JSON object on one line (no other text, no line breaks between fields).

Format: {"oneLiner":"...","keyMoments":[{"time":"2:30 PM","description":"..."}],"actionItems":[{"text":"...","urgency":"high"}],"peopleMentioned":[{"name":"...","context":"..."}]}

CRITICAL rules for oneLiner:
- MUST be under 15 words, ALL LOWERCASE, no period at the end
- casual like texting a friend, reference SPECIFIC topics from transcripts
- Good: "mostly debugging auth, quick call with sarah about launch"
- Good: "deep api refactor morning, slack catchup afternoon"
- Bad: "Had a productive day with various activities" (formal, generic)
- Bad: "Louis brainstorms potential features for the PipeStore, like user-driven sales" (too long, formal)

Other rules:
- keyMoments: max 5, with real timestamps from the data, specific descriptions
- actionItems: only real tasks mentioned in speech, urgency "high"/"medium"/"low"
- peopleMentioned: real people names ONLY (not apps/products), with context
- Empty arrays are fine if nothing found
- Output the JSON object on a SINGLE LINE, nothing else`;

function getStorageKey(date: string) {
  return `daily-summary-${date}`;
}

function loadSummary(date: string): DailySummary | null {
  try {
    const raw = localStorage?.getItem(getStorageKey(date));
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveSummary(summary: DailySummary) {
  try {
    localStorage?.setItem(getStorageKey(summary.date), JSON.stringify(summary));
  } catch {}
}

function isAppleIntelligenceEnabled(): boolean {
  try {
    return localStorage?.getItem("apple-intelligence-enabled") !== "false";
  } catch {
    return true;
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

async function isPluggedIn(): Promise<boolean> {
  try {
    const os = platform();
    if (os !== "macos") return true; // assume plugged in on non-mac

    const cmd = Command.create("exec-sh", [
      "-c",
      "pmset -g batt | head -1",
    ]);
    const output = await cmd.execute();
    return output.stdout.includes("AC Power");
  } catch {
    return true; // assume plugged in if detection fails
  }
}

async function checkAiAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${API}/ai/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.available === true;
  } catch {
    return false;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function DailySummaryCard({
  currentDate,
}: {
  currentDate: Date;
}) {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTriggeredRef = useRef<string>("");
  const isGeneratingRef = useRef(false);

  const dateStr =
    currentDate.getFullYear() +
    "-" +
    String(currentDate.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(currentDate.getDate()).padStart(2, "0");

  // Refs to hold latest values so the auto-trigger interval doesn't need
  // to re-mount whenever availability or date changes.
  const aiAvailableRef = useRef(false);
  const dateStrRef = useRef(dateStr);
  aiAvailableRef.current = aiAvailable;
  dateStrRef.current = dateStr;

  // Check AI availability (once on mount)
  useEffect(() => {
    const os = platform();
    if (os !== "macos") return;

    checkAiAvailable().then((available) => {
      setAiAvailable(available);
      setIsVisible(available && isAppleIntelligenceEnabled());
    });
  }, []);

  // Load cached summary when date changes
  useEffect(() => {
    const cached = loadSummary(dateStr);
    setSummary(cached);
    setIsExpanded(false);
    setError(null);
  }, [dateStr]);

  // ─── Generate Summary ─────────────────────────────────────────────────

  const generateSummary = useCallback(async () => {
    if (isGeneratingRef.current) return;
    isGeneratingRef.current = true;
    setIsGenerating(true);
    setError(null);

    try {
      const dayStart = new Date(dateStr + "T00:00:00");
      const dayEnd = new Date(dateStr + "T23:59:59");
      const now = new Date();
      const endTime = dayEnd > now ? now : dayEnd;

      // Fetch audio transcriptions for the day
      const params = new URLSearchParams({
        content_type: "audio",
        start_time: dayStart.toISOString(),
        end_time: endTime.toISOString(),
        limit: "100",
        min_length: "10",
      });
      const searchResp = await fetch(`${API}/search?${params}`);
      if (!searchResp.ok) throw new Error("Failed to fetch data");
      const searchData = await searchResp.json();

      const parts: string[] = [];
      for (const item of searchData.data || []) {
        if (item.type === "Audio") {
          const c = item.content;
          const text = c?.transcription?.trim();
          if (text) {
            const time = new Date(c.timestamp).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            });
            const speaker = c.speaker?.name || "";
            parts.push(`[${time}]${speaker ? ` ${speaker}:` : ""} ${text}`);
          }
        }
      }

      if (parts.length === 0) {
        setError("No audio data for this day");
        return;
      }

      // Truncate to fit in ~8K context window (prompt ~1K + data ~6K + response headroom)
      let context = parts.join("\n");
      if (context.length > 6000) context = context.slice(0, 6000);

      // Single AI call — fetch data ourselves, ask model to summarize as JSON
      const aiResp = await fetch(`${API}/ai/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: SUMMARY_PROMPT },
            { role: "user", content: context },
          ],
        }),
      });

      if (!aiResp.ok) throw new Error(`AI error: ${aiResp.status}`);
      const aiData = await aiResp.json();
      let raw = aiData.choices?.[0]?.message?.content || "{}";

      // Extract JSON from response (model may prepend text)
      raw = raw.trim();
      if (raw.startsWith("```")) {
        raw = raw.split("\n").slice(1).filter((l: string) => !l.startsWith("```")).join("\n");
      }
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];
      // Trim after last closing brace
      const lastBrace = raw.lastIndexOf("}");
      if (lastBrace >= 0) raw = raw.slice(0, lastBrace + 1);

      const parsed = JSON.parse(raw);

      const newSummary: DailySummary = {
        date: dateStr,
        generatedAt: new Date().toISOString(),
        timeBreakdown: [], // no screen data in audio-only mode
        keyMoments: (parsed.keyMoments || []).slice(0, 5),
        actionItems: (parsed.actionItems || []).map((a: any) => ({
          text: a.text || a.task || "",
          urgency: ["high", "medium", "low"].includes(a.urgency)
            ? a.urgency
            : "medium",
        })),
        peopleMentioned: parsed.peopleMentioned || [],
        oneLiner: parsed.oneLiner || "No summary available",
      };

      saveSummary(newSummary);
      setSummary(newSummary);
      setIsExpanded(true);
      posthog.capture("apple_intelligence_summary_generated", {
        key_moments: newSummary.keyMoments.length,
        action_items: newSummary.actionItems.length,
        people_mentioned: newSummary.peopleMentioned.length,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate summary");
    } finally {
      isGeneratingRef.current = false;
      setIsGenerating(false);
    }
  }, [dateStr]);

  // Auto-trigger at 6pm for today — single stable interval that reads
  // current values via refs to avoid re-mounting on every state change.
  useEffect(() => {
    const checkAutoTrigger = async () => {
      if (!aiAvailableRef.current) return;

      const now = new Date();
      const todayStr =
        now.getFullYear() +
        "-" +
        String(now.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(now.getDate()).padStart(2, "0");

      // Only auto-trigger for today, after 6pm, once per day
      if (dateStrRef.current !== todayStr) return;
      if (now.getHours() < 18) return;
      if (autoTriggeredRef.current === todayStr) return;
      if (loadSummary(todayStr)) return;

      // Check if plugged in
      const plugged = await isPluggedIn();
      if (!plugged) return;

      autoTriggeredRef.current = todayStr;
      generateSummary();
    };

    checkAutoTrigger();
    const interval = setInterval(checkAutoTrigger, 60000); // check every minute
    return () => clearInterval(interval);
  }, [generateSummary]);

  // ─── Copy ───────────────────────────────────────────────────────────────

  const copySummary = () => {
    if (!summary) return;
    const lines = [
      `# ${formatDate(summary.date)}`,
      "",
      summary.oneLiner,
      "",
    ];

    if (summary.timeBreakdown.length > 0) {
      lines.push("## Time");
      for (const t of summary.timeBreakdown) {
        const h = Math.floor(t.minutes / 60);
        const m = t.minutes % 60;
        lines.push(
          `- ${t.app}: ${h > 0 ? h + "h " : ""}${m > 0 ? m + "m" : ""}`
        );
      }
      lines.push("");
    }

    if (summary.keyMoments.length > 0) {
      lines.push("## Key Moments");
      for (const k of summary.keyMoments)
        lines.push(`- ${k.time} — ${k.description}`);
      lines.push("");
    }

    if (summary.actionItems.length > 0) {
      lines.push("## Action Items");
      for (const a of summary.actionItems) {
        const icon = a.urgency === "high" ? "⚡" : a.urgency === "medium" ? "●" : "○";
        lines.push(`- ${icon} ${a.text}`);
      }
      lines.push("");
    }

    if (summary.peopleMentioned.length > 0) {
      lines.push("## People");
      for (const p of summary.peopleMentioned)
        lines.push(`- ${p.name} — ${p.context}`);
    }

    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  if (!isVisible) return null;

  const urgencyIcon = (u: string) =>
    u === "high" ? "⚡" : u === "medium" ? "●" : "○";
  const urgencyColor = (u: string) =>
    u === "high"
      ? "text-orange-400"
      : u === "medium"
        ? "text-yellow-400"
        : "text-muted-foreground";

  // Compact icon button when no summary and not generating
  if (!summary && !isGenerating && !error) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => generateSummary()}
              className="w-10 h-10 backdrop-blur-xl bg-black/60 border border-white/10 rounded-xl flex items-center justify-center hover:bg-white/10 transition-colors shadow-2xl"
            >
              <img
                src="/apple-intelligence-logo.svg"
                alt="Generate daily summary"
                className="w-5 h-5 rounded"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" className="bg-black/80 border-white/10 text-white text-xs">
            <p>click to generate a daily summary</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <div className="w-72 backdrop-blur-xl bg-black/60 border border-white/10 rounded-xl overflow-hidden shadow-2xl">
      {/* Header — always visible */}
      <button
        onClick={() => {
          if (summary) {
            setIsExpanded(!isExpanded);
          } else {
            generateSummary();
          }
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/5 transition-colors"
      >
        <img
          src="/apple-intelligence-logo.svg"
          alt=""
          className="w-5 h-5 rounded flex-shrink-0"
        />
        <div className="flex-1 min-w-0 text-left">
          {isGenerating ? (
            <div className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-white/60" />
              <span className="text-xs text-white/60">
                generating summary...
              </span>
            </div>
          ) : summary ? (
            <p className="text-xs text-white/90 truncate">{summary.oneLiner}</p>
          ) : (
            <p className="text-xs text-white/50">
              tap to generate daily summary
            </p>
          )}
        </div>
        {summary && (
          <div className="flex-shrink-0">
            {isExpanded ? (
              <ChevronUp className="h-3 w-3 text-white/40" />
            ) : (
              <ChevronDown className="h-3 w-3 text-white/40" />
            )}
          </div>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="px-3 py-1.5 border-t border-white/5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-red-400 truncate flex-1">
              {error}
            </span>
            <button onClick={() => setError(null)}>
              <X className="h-2.5 w-2.5 text-white/30" />
            </button>
          </div>
        </div>
      )}

      {/* Expanded content */}
      {summary && isExpanded && (
        <div className="border-t border-white/10 max-h-[50vh] overflow-y-auto">
          {/* Time breakdown */}
          {summary.timeBreakdown.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5">
                time
              </p>
              <div className="space-y-1">
                {summary.timeBreakdown.map((t, i) => {
                  const maxMin = Math.max(
                    ...summary.timeBreakdown.map((x) => x.minutes)
                  );
                  const pct = maxMin > 0 ? (t.minutes / maxMin) * 100 : 0;
                  const h = Math.floor(t.minutes / 60);
                  const m = t.minutes % 60;
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10px] text-white/60 w-16 truncate">
                        {t.app}
                      </span>
                      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-white/30 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-white/40 w-10 text-right">
                        {h > 0 ? `${h}h` : ""}{m > 0 ? `${m}m` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Key moments */}
          {summary.keyMoments.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5">
                key moments
              </p>
              <div className="space-y-1">
                {summary.keyMoments.map((k, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-[10px] text-white/40 w-14 flex-shrink-0">
                      {k.time}
                    </span>
                    <span className="text-[10px] text-white/80">
                      {k.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action items */}
          {summary.actionItems.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5">
                action items
              </p>
              <div className="space-y-1">
                {summary.actionItems.map((a, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <span
                      className={`text-[10px] mt-px ${urgencyColor(a.urgency)}`}
                    >
                      {urgencyIcon(a.urgency)}
                    </span>
                    <span className="text-[10px] text-white/80">{a.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* People */}
          {summary.peopleMentioned.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <p className="text-[10px] text-white/40 uppercase tracking-wider mb-1.5">
                people
              </p>
              <div className="space-y-1">
                {summary.peopleMentioned.map((p, i) => (
                  <div key={i} className="flex gap-1.5">
                    <span className="text-[10px] text-white/70 font-medium">
                      {p.name}
                    </span>
                    <span className="text-[10px] text-white/40">
                      — {p.context}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="px-3 py-2 flex items-center justify-between">
            <span className="text-[9px] text-white/30">
              {new Date(summary.generatedAt).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
              {" · on-device"}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  generateSummary();
                }}
                className="px-2 py-0.5 text-[9px] text-white/40 hover:text-white/70 transition-colors"
                title="Regenerate"
              >
                ↻
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  copySummary();
                }}
                className="px-2 py-0.5 text-[9px] text-white/40 hover:text-white/70 transition-colors"
              >
                {copied ? (
                  <Check className="h-2.5 w-2.5 inline" />
                ) : (
                  <Copy className="h-2.5 w-2.5 inline" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
