// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { Settings, HelpCircle, Bug } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useGT } from "gt-react";
import { useFeedbackStore } from "@/lib/stores/feedback-store";


export function SidebarFooter({ onSettings, onHelp, onKeyboardShortcuts, isTranslucent = false, hideHelp = false, helpActive = false, trialActivationLocked = false }: {
  onSettings: () => void;
  onHelp: () => void;
  onKeyboardShortcuts?: () => void;
  isTranslucent?: boolean;
  hideHelp?: boolean;
  helpActive?: boolean;
  trialActivationLocked?: boolean;
}) {
  const ui = useGT();
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const itemStyle = isTranslucent ? "vibrant-nav-item vibrant-nav-hover" : "text-muted-foreground hover:bg-card/50 hover:text-foreground";
  const helpButton = <button type="button" data-testid="nav-help" data-announcement-anchor="sidebar-help" aria-label={ui("Help")}
    disabled={trialActivationLocked} onClick={onKeyboardShortcuts ? undefined : onHelp}
    className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150",
      trialActivationLocked && "cursor-not-allowed",
      helpActive ? isTranslucent ? "vibrant-nav-active" : "border border-border bg-card text-primary shadow-sm" : itemStyle)}>
    <HelpCircle className="h-4 w-4" />
  </button>;
  const help = <Tooltip>
    <TooltipTrigger asChild>{onKeyboardShortcuts ? <DropdownMenuTrigger asChild>{helpButton}</DropdownMenuTrigger> : helpButton}</TooltipTrigger>
    <TooltipContent side="top" className="text-xs">Help</TooltipContent>
  </Tooltip>;
  // One click to the feedback composer — the Help page stays for docs/tutorials.
  const feedback = <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" data-testid="nav-feedback" aria-label={ui("Send feedback")}
        disabled={trialActivationLocked} onClick={() => openFeedback()}
        className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150",
          trialActivationLocked && "cursor-not-allowed", itemStyle)}>
        <Bug className="h-4 w-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top" className="text-xs">Send feedback</TooltipContent>
  </Tooltip>;
  return <div className={cn("flex items-center gap-1 border-t pt-2", isTranslucent ? "vibrant-sidebar-border" : "border-border")}>
    <button data-testid="nav-settings" data-announcement-anchor="sidebar-settings" onClick={onSettings}
      className={cn("flex min-w-0 flex-1 items-center space-x-2.5 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 group", itemStyle)}>
      <Settings className="h-3.5 w-3.5 shrink-0" /><span className="truncate text-xs font-medium">Settings</span>
    </button>
    {feedback}
    {!hideHelp && (onKeyboardShortcuts ? <DropdownMenu>
      {help}
      <DropdownMenuContent side="top" align="end">
        <DropdownMenuItem onSelect={onHelp}>Help &amp; feedback</DropdownMenuItem>
        <DropdownMenuItem onSelect={onKeyboardShortcuts}>Keyboard shortcuts</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : help)}
  </div>;
}
