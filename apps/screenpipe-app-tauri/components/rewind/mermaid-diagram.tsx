"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

// Screenpipe brand theme: grayscale, sharp corners, minimal
const SCREENPIPE_THEME = {
  theme: "base" as const,
  themeVariables: {
    primaryColor: "#000000",
    primaryTextColor: "#ffffff",
    primaryBorderColor: "#000000",
    lineColor: "#666666",
    secondaryColor: "#ffffff",
    tertiaryColor: "#f0f0f0",
    background: "#ffffff",
    mainBkg: "#000000",
    secondBkg: "#f0f0f0",
    border1: "#000000",
    border2: "#666666",
    arrowheadColor: "#000000",
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: "14px",
    nodeBorder: "#000000",
    clusterBkg: "#f5f5f5",
    clusterBorder: "#000000",
    defaultLinkColor: "#666666",
    titleColor: "#000000",
    edgeLabelBackground: "#ffffff",
    nodeTextColor: "#ffffff",
  },
};

// Dark mode theme
const SCREENPIPE_THEME_DARK = {
  theme: "base" as const,
  themeVariables: {
    primaryColor: "#ffffff",
    primaryTextColor: "#000000",
    primaryBorderColor: "#ffffff",
    lineColor: "#999999",
    secondaryColor: "#000000",
    tertiaryColor: "#1a1a1a",
    background: "#000000",
    mainBkg: "#ffffff",
    secondBkg: "#1a1a1a",
    border1: "#ffffff",
    border2: "#999999",
    arrowheadColor: "#ffffff",
    fontFamily: "IBM Plex Mono, monospace",
    fontSize: "14px",
    nodeBorder: "#ffffff",
    clusterBkg: "#1a1a1a",
    clusterBorder: "#ffffff",
    defaultLinkColor: "#999999",
    titleColor: "#ffffff",
    edgeLabelBackground: "#000000",
    nodeTextColor: "#000000",
  },
};

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const renderDiagram = async () => {
      if (!containerRef.current || !chart.trim()) return;

      try {
        // Detect dark mode
        const isDark = document.documentElement.classList.contains("dark");
        const theme = isDark ? SCREENPIPE_THEME_DARK : SCREENPIPE_THEME;

        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          ...theme,
        });

        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart.trim());
        setSvg(renderedSvg);
        setError(null);
      } catch (err) {
        console.error("Mermaid render error:", err);
        setError(err instanceof Error ? err.message : "Failed to render diagram");
      }
    };

    renderDiagram();
  }, [chart]);

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
