"use client";

import { useEffect, useRef, useState } from "react";

// Screenpipe brand theme — outlined minimalist (DESIGN.md):
// white fills, black 1px borders, black text in light mode (inverted in dark).
// Avoids the heavy filled-black-box look; matches the rest of the app's flat,
// high-contrast, color-free aesthetic.
const SCREENPIPE_THEME = {
  theme: "base" as const,
  themeVariables: {
    primaryColor: "#ffffff",
    primaryTextColor: "#000000",
    primaryBorderColor: "#000000",
    lineColor: "#000000",
    secondaryColor: "#f5f5f5",
    tertiaryColor: "#e5e5e5",
    background: "#ffffff",
    mainBkg: "#ffffff",
    secondBkg: "#f5f5f5",
    tertiaryBkg: "#e5e5e5",
    border1: "#000000",
    border2: "#000000",
    arrowheadColor: "#000000",
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: "14px",
    nodeBorder: "#000000",
    clusterBkg: "#f5f5f5",
    clusterBorder: "#000000",
    defaultLinkColor: "#000000",
    titleColor: "#000000",
    edgeLabelBackground: "#ffffff",
    nodeTextColor: "#000000",
    textColor: "#000000",
    labelColor: "#000000",
    labelTextColor: "#000000",
    actorTextColor: "#000000",
    actorBorder: "#000000",
    actorBkg: "#ffffff",
    noteBkgColor: "#f5f5f5",
    noteTextColor: "#000000",
    noteBorderColor: "#000000",
  },
};

const SCREENPIPE_THEME_DARK = {
  theme: "base" as const,
  themeVariables: {
    primaryColor: "#000000",
    primaryTextColor: "#ffffff",
    primaryBorderColor: "#ffffff",
    lineColor: "#ffffff",
    secondaryColor: "#1a1a1a",
    tertiaryColor: "#262626",
    background: "#000000",
    mainBkg: "#000000",
    secondBkg: "#1a1a1a",
    tertiaryBkg: "#262626",
    border1: "#ffffff",
    border2: "#ffffff",
    arrowheadColor: "#ffffff",
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: "14px",
    nodeBorder: "#ffffff",
    clusterBkg: "#1a1a1a",
    clusterBorder: "#ffffff",
    defaultLinkColor: "#ffffff",
    titleColor: "#ffffff",
    edgeLabelBackground: "#000000",
    nodeTextColor: "#ffffff",
    textColor: "#ffffff",
    labelColor: "#ffffff",
    labelTextColor: "#ffffff",
    actorTextColor: "#ffffff",
    actorBorder: "#ffffff",
    actorBkg: "#000000",
    noteBkgColor: "#1a1a1a",
    noteTextColor: "#ffffff",
    noteBorderColor: "#ffffff",
  },
};

// Belt-and-suspenders CSS injected into the SVG to override any mermaid
// internals that ignore theme variables (label foreignObject text, edge
// labels, etc). Without this, certain node/text classes render with
// hardcoded colors that look washed out.
const themeStyle = (isDark: boolean) => {
  const fg = isDark ? "#ffffff" : "#000000";
  const bg = isDark ? "#000000" : "#ffffff";
  const cluster = isDark ? "#1a1a1a" : "#f5f5f5";
  return `
    .node rect, .node polygon, .node circle, .node ellipse, .node path {
      fill: ${bg} !important;
      stroke: ${fg} !important;
      stroke-width: 1px !important;
    }
    .cluster rect {
      fill: ${cluster} !important;
      stroke: ${fg} !important;
      stroke-width: 1px !important;
    }
    .node .label, .node text, .nodeLabel, .nodeLabel p,
    .cluster .label, .cluster text, .cluster-label text,
    .edgeLabel, .edgeLabel p, .edgeLabel rect {
      color: ${fg} !important;
      fill: ${fg} !important;
    }
    .edgeLabel { background-color: ${bg} !important; }
    .edgeLabel rect { fill: ${bg} !important; }
    .flowchart-link, .edge-thickness-normal, .edge-pattern-solid, path.path {
      stroke: ${fg} !important;
    }
    .arrowheadPath, marker path {
      fill: ${fg} !important;
      stroke: ${fg} !important;
    }
  `;
};

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const renderDiagram = async () => {
      if (!containerRef.current || !chart.trim()) return;

      try {
        const { default: mermaid } = await import("mermaid");

        const theme = isDark ? SCREENPIPE_THEME_DARK : SCREENPIPE_THEME;

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          ...theme,
        });

        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart.trim());
        const styled = renderedSvg.replace(
          /<svg([^>]*)>/,
          `<svg$1><style>${themeStyle(isDark)}</style>`,
        );
        setSvg(styled);
        setError(null);
      } catch (err) {
        console.error("Mermaid render error:", err);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
      }
    };

    renderDiagram();
  }, [chart, isDark]);

  if (error) {
    return (
      <div className="border border-destructive/50 bg-destructive/10 p-4 my-2 font-mono text-sm">
        <p className="text-destructive mb-2">diagram error:</p>
        <pre className="text-xs overflow-auto">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`my-4 overflow-x-auto ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
