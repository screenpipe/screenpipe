// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Globe2,
  Plug,
  PanelRightClose,
} from "lucide-react";
import type { SourceCitation } from "@/lib/source-citations";
import { useGT } from "gt-react";

export function ChatPanelHome({
  view,
  onViewChange,
  outputs,
  paths,
  onOpenBrowser,
  onOpenFile,
  onClose,
}: {
  view: "home" | "files";
  onViewChange: (view: "home" | "files") => void;
  outputs: SourceCitation[];
  paths: string[];
  onOpenBrowser: () => void;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const ui = useGT();
  const files = [
    ...new Map([
      ...paths.map(
        (path) =>
          [path, { path, title: path.split(/[\\/]/).pop() || path }] as const,
      ),
      ...outputs
        .filter((output) => output.path)
        .map(
          (output) =>
            [
              output.path!,
              { path: output.path!, title: output.title },
            ] as const,
        ),
    ]).values(),
  ];
  const destinations = [
    {
      label: ui("Browser"),
      detail: ui("Open a website beside your conversation."),
      Icon: Globe2,
      run: onOpenBrowser,
    },
    {
      label: ui("Files and outputs"),
      detail: files.length
        ? ui("{count} available in this chat", { count: files.length })
        : ui("Find files you preview and results created here."),
      Icon: FileText,
      run: () => onViewChange("files"),
    },
    {
      label: ui("Connections"),
      detail: ui("Add the apps your next task needs."),
      Icon: Plug,
      run: () =>
        window.dispatchEvent(
          new CustomEvent("open-settings", {
            detail: { section: "connections" },
          }),
        ),
    },
  ];
  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-background"
      aria-label={ui("Chat tools")}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-4">
        {view === "files" ? (
          <button
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onViewChange("home")}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {ui("Chat tools")}
          </button>
        ) : (
          <span className="text-xs font-medium">{ui("Chat tools")}</span>
        )}
        <button
          aria-label={ui("Close right sidebar")}
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        {view === "home" ? (
          <div className="my-auto w-full max-w-sm self-center">
            <h2 className="text-base font-medium">
              {ui("Keep your work close")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {ui(
                "Browse a page, revisit a result, or connect an app while you chat.",
              )}
            </p>
            <div className="mt-6 space-y-2">
              {destinations.map(({ label, detail, Icon, run }) => (
                <button
                  key={label}
                  onClick={run}
                  className="group flex w-full items-center gap-3 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {detail}
                    </span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="w-full">
            <h2 className="text-sm font-medium">{ui("Files and outputs")}</h2>
            {files.length ? (
              <ul className="mt-4 space-y-2">
                {files.map((file) => (
                  <li key={file.path}>
                    <button
                      onClick={() => onOpenFile(file.path)}
                      title={file.path}
                      className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate text-xs">
                        {file.title}
                      </span>
                      <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-10 rounded-lg border border-dashed border-border p-6 text-center">
                <FileText className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                <h3 className="text-sm font-medium">
                  {ui("No files in this chat yet")}
                </h3>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {ui(
                    "Open a file from a response, or ask Screenpipe to create a report. It will appear here.",
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
