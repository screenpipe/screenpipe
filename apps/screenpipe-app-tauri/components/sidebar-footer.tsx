// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { Settings, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function SidebarFooter({ onSettings, onHelp, onKeyboardShortcuts, isTranslucent = false, hideHelp = false, helpActive = false, trialActivationLocked = false }: {
  onSettings: () => void;
  onHelp: () => void;
  onKeyboardShortcuts?: () => void;
  isTranslucent?: boolean;
  hideHelp?: boolean;
  helpActive?: boolean;
  trialActivationLocked?: boolean;
}) {
  const itemStyle = isTranslucent ? "vibrant-nav-item vibrant-nav-hover" : "text-muted-foreground hover:bg-card/50 hover:text-foreground";
  const helpButton = <button type="button" data-testid="nav-help" data-announcement-anchor="sidebar-help" aria-label="Help"
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
  return <div className={cn("flex items-center gap-1 border-t pt-2", isTranslucent ? "vibrant-sidebar-border" : "border-border")}>
    <button data-testid="nav-settings" data-announcement-anchor="sidebar-settings" onClick={onSettings}
      className={cn("flex min-w-0 flex-1 items-center space-x-2.5 rounded-lg px-2.5 py-1.5 text-left transition-all duration-150 group", itemStyle)}>
      <Settings className="h-3.5 w-3.5 shrink-0" /><span className="truncate text-xs font-medium">Settings</span>
    </button>
    {!hideHelp && (onKeyboardShortcuts ? <DropdownMenu>
      {help}
      <DropdownMenuContent side="top" align="end">
        <DropdownMenuItem onSelect={onHelp}>Help &amp; feedback</DropdownMenuItem>
        <DropdownMenuItem onSelect={onKeyboardShortcuts}>Keyboard shortcuts</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : help)}
  </div>;
}
