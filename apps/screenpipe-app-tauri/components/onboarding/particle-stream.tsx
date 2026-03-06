"use client";

import React, { useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface Props {
  progress: number;
  width?: number;
  height?: number;
  className?: string;
}

// ─── constants ───────────────────────────────────────────
const GLITCH_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>[]{}|/=+~";
const TEXT_L1 = "upgrading your";
const TEXT_L2 = "memory";
const MEMORY_FRAGMENTS = [
  "13:42:07", "chrome", "screenshot", "meeting", "2026-02-02",
  "email_draft", "slack", "terminal", "vscode", "figma",
  "notion", "14:08:33", "recording_", "memory_03", "frame_2847",
  "audio_in", "ocr_batch", "context_q", "index_07", "recall",
];

// ─── types ───────────────────────────────────────────────
interface Node {
  x: number; y: number;
  ring: number;          // 0=outer, 1=mid, 2=inner
  activation: number;    // progress threshold to activate
  brightness: number;
}
interface Connection {
  from: number; to: number;
  activation: number;    // progress threshold
  drawProg: number;      // 0→1 animated draw
  heat: number;          // brightens when pulse passes
}
interface Pulse {
  connIdx: number;
  t: number;             // 0→1 along connection
  speed: number;
  brightness: number;
}
interface RainCol {
  x: number;
  chars: { y: number; ch: string; speed: number; opacity: number }[];
}
interface TextGlyph {
  target: string;
  current: string;
  decodeFrame: number;   // frame at which it decodes
  decoded: boolean;
  sourceChars: string[]; // chars from memory fragments to cycle through
  sourceIdx: number;     // current position in sourceChars
}
interface Fragment {
  x: number; y: number;
  text: string;
  life: number; maxLife: number;
  opacity: number;
}
interface State {
  nodes: Node[];
  conns: Connection[];
  pulses: Pulse[];
  rain: RainCol[];
  line1: TextGlyph[];
  line2: TextGlyph[];
  frags: Fragment[];
  scanY: number;
  centerGlow: number;
  decodeFlash: number;  // 0→1→0 flash when text fully decoded
}

// ─── helpers ─────────────────────────────────────────────
const rng = () => Math.random();
const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
const randChar = () => GLITCH_CHARS[Math.floor(rng() * GLITCH_CHARS.length)];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function initState(w: number, h: number): State {
  const cx = w / 2, cy = h * 0.42;

  // ── nodes in 3 rings ──
  const nodes: Node[] = [];
  const rings = [
    { count: 10, radius: Math.min(w, h) * 0.44, act: 0.10 },
    { count: 8,  radius: Math.min(w, h) * 0.28, act: 0.25 },
    { count: 5,  radius: Math.min(w, h) * 0.13, act: 0.40 },
  ];
  rings.forEach((ring, ri) => {
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 + ri * 0.3;
      const jitter = ring.radius * 0.15;
      nodes.push({
        x: cx + Math.cos(angle) * ring.radius + (rng() - 0.5) * jitter,
        y: cy + Math.sin(angle) * ring.radius * 0.6 + (rng() - 0.5) * jitter * 0.6,
        ring: ri,
        activation: ring.act + rng() * 0.1,
        brightness: 0,
      });
    }
  });

  // ── connections: outer→mid, mid→inner, inner→center ──
  const conns: Connection[] = [];
  const byRing = (r: number) => nodes.map((n, i) => ({ n, i })).filter(x => x.n.ring === r);
  const outer = byRing(0), mid = byRing(1), inner = byRing(2);

  // Connect each mid node to 1-2 nearest outer nodes
  mid.forEach(m => {
    const sorted = [...outer].sort((a, b) =>
      Math.hypot(a.n.x - m.n.x, a.n.y - m.n.y) - Math.hypot(b.n.x - m.n.x, b.n.y - m.n.y)
    );
    const count = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < count && i < sorted.length; i++) {
      conns.push({ from: sorted[i].i, to: m.i, activation: 0.15 + rng() * 0.15, drawProg: 0, heat: 0 });
    }
  });
  // Connect each inner node to 1-2 nearest mid nodes
  inner.forEach(n => {
    const sorted = [...mid].sort((a, b) =>
      Math.hypot(a.n.x - n.n.x, a.n.y - n.n.y) - Math.hypot(b.n.x - n.n.x, b.n.y - n.n.y)
    );
    const count = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < count && i < sorted.length; i++) {
      conns.push({ from: sorted[i].i, to: n.i, activation: 0.30 + rng() * 0.15, drawProg: 0, heat: 0 });
    }
  });
  // Connect inner nodes to center point (virtual — we draw toward cx,cy)
  inner.forEach(n => {
    conns.push({ from: n.i, to: -1, activation: 0.45 + rng() * 0.1, drawProg: 0, heat: 0 });
  });

  // ── rain columns ──
  const rain: RainCol[] = [];
  const colCount = Math.floor(w / 28);
  for (let c = 0; c < colCount; c++) {
    const x = 8 + c * (w / colCount) + (rng() - 0.5) * 8;
    const chars: RainCol["chars"] = [];
    const count = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++) {
      chars.push({
        y: rng() * h,
        ch: randChar(),
        speed: 0.3 + rng() * 0.5,
        opacity: 0.03 + rng() * 0.05,
      });
    }
    rain.push({ x, chars });
  }

  // ── text glyphs ──
  // Build a cycle sequence from memory fragments for each character.
  // Prefer fragments starting with the same letter, then fill from others.
  const buildSourceChars = (ch: string): string[] => {
    const upper = ch.toUpperCase();
    const chars: string[] = [];
    // chars from fragments that start with the same letter
    for (const frag of MEMORY_FRAGMENTS) {
      if (frag[0].toUpperCase() === upper) {
        for (const c of frag.toUpperCase()) {
          if (c !== "_" && !chars.includes(c)) chars.push(c);
        }
      }
    }
    // pad from other fragments so the cycle is 10+ chars long
    while (chars.length < 12) {
      const frag = pick(MEMORY_FRAGMENTS);
      const c = frag[Math.floor(rng() * frag.length)].toUpperCase();
      if (c !== "_" && !chars.includes(c)) chars.push(c);
      if (chars.length < 12 && GLITCH_CHARS.length > 0) {
        chars.push(randChar());
      }
    }
    return chars;
  };

  const makeGlyphs = (text: string, baseFrame: number): TextGlyph[] =>
    text.split("").map((ch, i) => {
      const src = ch === " " ? [] : buildSourceChars(ch);
      return {
        target: ch,
        current: ch === " " ? " " : src[0] || randChar(),
        decodeFrame: baseFrame + i * 4 + Math.floor(rng() * 8),
        decoded: ch === " ",
        sourceChars: src,
        sourceIdx: 0,
      };
    });
  const line1 = makeGlyphs(TEXT_L1, 30);   // starts decoding ~0.5s in
  const line2 = makeGlyphs(TEXT_L2, 60);   // starts ~1s in

  return {
    nodes, conns, pulses: [], rain,
    line1, line2,
    frags: [],
    scanY: 0,
    centerGlow: 0,
    decodeFlash: 0,
  };
}

// ─── component ───────────────────────────────────────────
export function ParticleStream({
  progress,
  width = 420,
  height = 180,
  className = "",
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const progressRef = useRef(progress);
  const stateRef = useRef<State | null>(null);
  const frameRef = useRef(0);

  useEffect(() => { progressRef.current = progress; }, [progress]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const state = initState(width, height);
    stateRef.current = state;

    const cx = width / 2, cy = height * 0.42;

    let stopped = false;

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animRef.current);
      } else if (!stopped) {
        animRef.current = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    function draw() {
      if (stopped) return;

      const p = progressRef.current;
      const f = ++frameRef.current;
      const s = state;

      ctx.clearRect(0, 0, width, height);

      // ════════════════════════════════════════════════════
      // LAYER 1: Rain — faint falling characters
      // ════════════════════════════════════════════════════
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      for (const col of s.rain) {
        for (const ch of col.chars) {
          ch.y += ch.speed * (0.8 + p * 1.2);
          if (ch.y > height + 10) { ch.y = -10; ch.ch = randChar(); }
          // cycle char occasionally
          if (rng() < 0.02) ch.ch = randChar();
          const alpha = ch.opacity * (0.5 + p * 0.8);
          const gray = 120 + Math.floor(rng() * 40);
          ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
          ctx.fillText(ch.ch, col.x, ch.y);
        }
      }

      // ════════════════════════════════════════════════════
      // LAYER 2: Network connections
      // ════════════════════════════════════════════════════
      for (const conn of s.conns) {
        // animate draw progress
        if (p > conn.activation) {
          conn.drawProg = Math.min(1, conn.drawProg + 0.012);
        }
        conn.heat *= 0.96; // decay heat

        if (conn.drawProg < 0.01) continue;

        const fromN = s.nodes[conn.from];
        const toX = conn.to === -1 ? cx : s.nodes[conn.to].x;
        const toY = conn.to === -1 ? cy : s.nodes[conn.to].y;

        const dx = toX - fromN.x, dy = toY - fromN.y;
        const endX = fromN.x + dx * conn.drawProg;
        const endY = fromN.y + dy * conn.drawProg;

        const baseAlpha = 0.06 + conn.heat * 0.5;
        const gray = 130 + Math.floor(conn.heat * 125);
        ctx.strokeStyle = `rgba(${gray},${gray},${gray},${baseAlpha + conn.drawProg * 0.08})`;
        ctx.lineWidth = 0.5 + conn.heat * 1.5;
        ctx.beginPath();
        ctx.moveTo(fromN.x, fromN.y);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }

      // ════════════════════════════════════════════════════
      // LAYER 3: Data pulses
      // ════════════════════════════════════════════════════
      // spawn pulses on active connections
      if (f % Math.max(2, Math.floor(12 - p * 10)) === 0) {
        const active = s.conns.filter(c => c.drawProg > 0.8);
        if (active.length > 0) {
          const conn = pick(active);
          const ci = s.conns.indexOf(conn);
          s.pulses.push({
            connIdx: ci,
            t: 0,
            speed: 0.015 + p * 0.02 + rng() * 0.01,
            brightness: 0.6 + rng() * 0.4,
          });
        }
      }

      for (let i = s.pulses.length - 1; i >= 0; i--) {
        const pulse = s.pulses[i];
        pulse.t += pulse.speed;

        if (pulse.t > 1) {
          // heat up the connection
          s.conns[pulse.connIdx].heat = Math.min(1, s.conns[pulse.connIdx].heat + 0.5);
          s.pulses.splice(i, 1);
          continue;
        }

        const conn = s.conns[pulse.connIdx];
        const fromN = s.nodes[conn.from];
        const toX = conn.to === -1 ? cx : s.nodes[conn.to].x;
        const toY = conn.to === -1 ? cy : s.nodes[conn.to].y;

        const px = lerp(fromN.x, toX, pulse.t);
        const py = lerp(fromN.y, toY, pulse.t);
        const sz = 1.5 + pulse.brightness;

        // glow
        const gray = Math.floor(180 + pulse.brightness * 75);
        ctx.shadowColor = `rgba(${gray},${gray},${gray},0.8)`;
        ctx.shadowBlur = 6;
        ctx.fillStyle = `rgba(${gray},${gray},${gray},${pulse.brightness * 0.9})`;
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
        ctx.shadowBlur = 0;
      }

      // ════════════════════════════════════════════════════
      // LAYER 4: Central singularity
      // ════════════════════════════════════════════════════
      s.centerGlow = lerp(s.centerGlow, p, 0.02);
      const g = s.centerGlow;

      if (g > 0.05) {
        // Radial glow
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 50 + g * 40);
        grad.addColorStop(0, `rgba(200,200,200,${g * 0.15})`);
        grad.addColorStop(0.5, `rgba(150,150,150,${g * 0.06})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(cx - 100, cy - 80, 200, 160);

        // Nested rotating sharp squares
        ctx.save();
        ctx.translate(cx, cy);
        for (let sq = 0; sq < 3; sq++) {
          const size = 4 + sq * 6 + g * 8;
          const rotation = f * (0.003 + sq * 0.002) * (sq % 2 === 0 ? 1 : -1);
          const alpha = g * (0.15 - sq * 0.03);
          ctx.save();
          ctx.rotate(rotation);
          ctx.strokeStyle = `rgba(200,200,200,${alpha})`;
          ctx.lineWidth = 0.7;
          ctx.strokeRect(-size / 2, -size / 2, size, size);
          ctx.restore();
        }
        ctx.restore();

        // Bright core dot
        const coreAlpha = g * (0.4 + Math.sin(f * 0.05) * 0.15);
        ctx.shadowColor = `rgba(220,220,220,${coreAlpha})`;
        ctx.shadowBlur = 12 + g * 8;
        ctx.fillStyle = `rgba(230,230,230,${coreAlpha})`;
        ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
        ctx.shadowBlur = 0;
      }

      // ════════════════════════════════════════════════════
      // LAYER 5: Scan line
      // ════════════════════════════════════════════════════
      s.scanY += 0.4 + p * 0.3;
      if (s.scanY > height + 2) s.scanY = -2;

      ctx.fillStyle = `rgba(180,180,180,${0.03 + p * 0.04})`;
      ctx.fillRect(0, s.scanY, width, 1);
      ctx.fillStyle = `rgba(150,150,150,${0.015 + p * 0.02})`;
      ctx.fillRect(0, s.scanY - 1, width, 3);

      // ════════════════════════════════════════════════════
      // LAYER 6: Nodes
      // ════════════════════════════════════════════════════
      for (const node of s.nodes) {
        if (p > node.activation) {
          node.brightness = Math.min(1, node.brightness + 0.02);
        }
        if (node.brightness < 0.01) continue;

        const nb = node.brightness;
        const pulse = 0.6 + Math.sin(f * 0.025 + node.x * 0.01) * 0.4;
        const sz = 2 + nb * 1.5;
        const gray = Math.floor(120 + nb * 100 * pulse);
        const alpha = nb * 0.5 * pulse;

        ctx.shadowColor = `rgba(${gray},${gray},${gray},${alpha})`;
        ctx.shadowBlur = 3;
        ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
        ctx.fillRect(node.x - sz / 2, node.y - sz / 2, sz, sz);
        ctx.shadowBlur = 0;
      }

      // ════════════════════════════════════════════════════
      // LAYER 7: Memory fragments (edge flashes)
      // ════════════════════════════════════════════════════
      if (p > 0.1 && f % 35 === 0 && s.frags.length < 4) {
        const edge = Math.floor(rng() * 4); // 0=top, 1=right, 2=bottom, 3=left
        let fx: number, fy: number;
        switch (edge) {
          case 0: fx = rng() * width; fy = 6; break;
          case 1: fx = width - 8; fy = rng() * height; break;
          case 2: fx = rng() * width; fy = height - 8; break;
          default: fx = 8; fy = rng() * height; break;
        }
        s.frags.push({
          x: fx, y: fy,
          text: pick(MEMORY_FRAGMENTS),
          life: 0, maxLife: 50 + Math.floor(rng() * 30),
          opacity: 0.06 + rng() * 0.08,
        });
      }

      ctx.font = "7px monospace";
      ctx.textAlign = "left";
      for (let i = s.frags.length - 1; i >= 0; i--) {
        const frag = s.frags[i];
        frag.life++;
        if (frag.life > frag.maxLife) { s.frags.splice(i, 1); continue; }
        const fadeIn = Math.min(1, frag.life / 8);
        const fadeOut = Math.max(0, 1 - (frag.life - frag.maxLife + 12) / 12);
        const a = frag.opacity * fadeIn * fadeOut;
        ctx.fillStyle = `rgba(150,150,150,${a})`;
        ctx.fillText(frag.text, frag.x, frag.y);
      }

      // ════════════════════════════════════════════════════
      // LAYER 8: Text — decode effect
      // ════════════════════════════════════════════════════
      const allDecoded1 = updateTextGlyphs(s.line1, f);
      const allDecoded2 = updateTextGlyphs(s.line2, f);

      // Flash when fully decoded
      if (allDecoded1 && allDecoded2 && s.decodeFlash === 0) {
        s.decodeFlash = 1;
      }
      if (s.decodeFlash > 0) {
        s.decodeFlash *= 0.96;
        if (s.decodeFlash < 0.01) s.decodeFlash = 0;
        const flashGrad = ctx.createRadialGradient(cx, cy + 10, 0, cx, cy + 10, 120);
        flashGrad.addColorStop(0, `rgba(220,220,220,${s.decodeFlash * 0.25})`);
        flashGrad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = flashGrad;
        ctx.fillRect(0, 0, width, height);
      }

      // Draw line 1: "upgrading your"
      const charW1 = 8.2;
      const totalW1 = s.line1.length * charW1;
      const startX1 = cx - totalW1 / 2;
      const textY = height * 0.78;

      ctx.font = "600 11px monospace";
      ctx.textAlign = "left";
      for (let i = 0; i < s.line1.length; i++) {
        const gl = s.line1[i];
        const isDecoding = !gl.decoded && f > gl.decodeFrame - 10;
        const gray = gl.decoded ? 200 : (isDecoding ? 140 : 80);
        const alpha = gl.decoded ? 0.85 : (isDecoding ? 0.6 : 0.3);

        if (gl.decoded) {
          ctx.shadowColor = `rgba(200,200,200,0.3)`;
          ctx.shadowBlur = 4;
        }
        ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
        ctx.fillText(gl.current, startX1 + i * charW1, textY);
        ctx.shadowBlur = 0;
      }

      // Draw line 2: "memory"
      const charW2 = 10.5;
      const totalW2 = s.line2.length * charW2;
      const startX2 = cx - totalW2 / 2;
      const textY2 = textY + 20;

      ctx.font = "700 15px monospace";
      for (let i = 0; i < s.line2.length; i++) {
        const gl = s.line2[i];
        const isDecoding = !gl.decoded && f > gl.decodeFrame - 10;
        const gray = gl.decoded ? 220 : (isDecoding ? 150 : 70);
        const alpha = gl.decoded ? 0.95 : (isDecoding ? 0.6 : 0.25);

        if (gl.decoded) {
          ctx.shadowColor = `rgba(220,220,220,0.4)`;
          ctx.shadowBlur = 6;
        }
        ctx.fillStyle = `rgba(${gray},${gray},${gray},${alpha})`;
        ctx.fillText(gl.current, startX2 + i * charW2, textY2);
        ctx.shadowBlur = 0;

        // Brief flash when this char just decoded
        if (gl.decoded && f - gl.decodeFrame < 8) {
          const flashA = (1 - (f - gl.decodeFrame) / 8) * 0.4;
          ctx.shadowColor = `rgba(220,220,220,${flashA})`;
          ctx.shadowBlur = 10;
          ctx.fillStyle = `rgba(220,220,220,${flashA})`;
          ctx.fillText(gl.current, startX2 + i * charW2, textY2);
          ctx.shadowBlur = 0;
        }
      }

      // ════════════════════════════════════════════════════
      // LAYER 9: Vignette
      // ════════════════════════════════════════════════════
      const vig = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.15, cx, cy, Math.max(w, h) * 0.65);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, `rgba(0,0,0,${0.03 + (1 - p) * 0.05})`);
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, width, height);

      // Thin progress bar at absolute bottom
      const barW = width * 0.6;
      const barX = (width - barW) / 2;
      const barY = height - 3;
      ctx.fillStyle = "rgba(100,100,100,0.15)";
      ctx.fillRect(barX, barY, barW, 1);
      ctx.fillStyle = `rgba(200,200,200,${0.3 + p * 0.5})`;
      ctx.fillRect(barX, barY, barW * clamp(p, 0, 1), 1);

      animRef.current = requestAnimationFrame(draw);
    }

    const w = width, h = height; // closure
    if (!document.hidden) {
      animRef.current = requestAnimationFrame(draw);
    }
    return () => {
      stopped = true;
      cancelAnimationFrame(animRef.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className={className}
    />
  );
}

// ─── text glyph updater ─────────────────────────────────
function updateTextGlyphs(glyphs: TextGlyph[], frame: number): boolean {
  let allDone = true;
  for (const gl of glyphs) {
    if (gl.target === " ") continue;
    if (!gl.decoded) {
      // Cycle through memory-sourced chars instead of random noise
      if (frame % 3 === 0 && gl.sourceChars.length > 0) {
        gl.sourceIdx = (gl.sourceIdx + 1) % gl.sourceChars.length;
        gl.current = gl.sourceChars[gl.sourceIdx];
      }
      // Decode when frame reaches threshold
      if (frame >= gl.decodeFrame) {
        gl.decoded = true;
        gl.current = gl.target;
        gl.decodeFrame = frame; // record actual decode frame
      } else {
        allDone = false;
      }
    } else {
      // Occasional re-glitch shows a memory fragment char briefly
      if (rng() < 0.002 && gl.sourceChars.length > 0) {
        gl.current = pick(gl.sourceChars);
        setTimeout(() => { gl.current = gl.target; }, 80);
      }
    }
  }
  return allDone;
}

// ─── progress steps ──────────────────────────────────────
export function ProgressSteps({
  steps,
  className = "",
}: {
  steps: Array<{ label: string; done: boolean; active: boolean }>;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-center gap-5 ${className}`}>
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <motion.div
            className={`w-1 h-1 ${
              step.done
                ? "bg-foreground"
                : step.active
                ? "bg-foreground/50"
                : "bg-foreground/15"
            }`}
            animate={
              step.active
                ? { opacity: [0.4, 1, 0.4] }
                : {}
            }
            transition={
              step.active
                ? { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
                : {}
            }
          />
          <span
            className={`font-mono text-[9px] tracking-wider uppercase ${
              step.done
                ? "text-foreground"
                : step.active
                ? "text-foreground/60"
                : "text-foreground/20"
            }`}
          >
            {step.label}
          </span>
        </div>
      ))}
    </div>
  );
}
