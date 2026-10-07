// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useState } from "react";
import { Shield, Sparkles } from "lucide-react";
import { AIPresetsSelector } from "@/components/rewind/ai-presets-selector";
import { workflowModelPreference } from "@/lib/workflows/model-choice";
import { supportsWorkflowPreset } from "@/lib/workflows/model-provider";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import {
  ConfidentialVerificationDetails,
  useConfidentialVerification,
} from "@screenpipe/workflows-ui";
import type {
  WorkflowModelMode,
  WorkflowModelPreference,
} from "@screenpipe/workflows-ui";

export function WorkflowModelSelector({
  preference = workflowModelPreference,
}: {
  preference?: WorkflowModelPreference;
}) {
  const [mode, setMode] = useState<WorkflowModelMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { isManagedDeployment, policy } = useManagedPolicy();
  const cloudAllowed =
    !isManagedDeployment ||
    policy.aiPresetPolicy?.allow_screenpipe_cloud !== false;
  const verification = useConfidentialVerification(preference.verification);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void preference
        .load()
        .then((value) => {
          if (active) {
            setMode(value);
            setError("");
          }
        })
        .catch(() => {
          if (active) {
            setMode(null);
            setError("Could not read your AI choice. Choose it again.");
          }
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("workflows:model-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("workflows:model-changed", refresh);
    };
  }, [preference]);
  async function choose(value: WorkflowModelMode) {
    setBusy(true);
    setError("");
    try {
      await preference.save(value);
      setMode(value);
    } catch {
      setError("Could not save your AI choice. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <AIPresetsSelector
        compact
        containerClassName="w-auto"
        triggerClassName="max-w-[240px]"
        triggerAriaLabel="Workflows AI"
        allowAgentPresets={false}
        shortcutKey=""
        disabled={busy}
        presetFilter={supportsWorkflowPreset}
        controlledPresetId={mode?.startsWith("preset:") ? mode.slice(7) : null}
        selectionLabel={
          busy ? (
            "Saving…"
          ) : mode === "intelligent" ? (
            <span className="flex min-w-0 items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0 opacity-80" />
              <span>Intelligent</span>
            </span>
          ) : mode === "private" ? (
            <span className="flex min-w-0 items-center gap-2">
              <Shield className="h-4 w-4 shrink-0 opacity-80" />
              <span>Private</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                Beta
              </span>
            </span>
          ) : undefined
        }
        onControlledSelect={(preset) => {
          if (preset && supportsWorkflowPreset(preset))
            void choose(`preset:${preset.id}`);
          else
            setError(
              "This agent is not supported by Workflows. Choose a model preset.",
            );
        }}
        builtinOptions={
          cloudAllowed
            ? [
                {
                  id: "workflow-intelligent",
                  label: "Intelligent",
                  icon: <Sparkles className="h-4 w-4" />,
                  description: "Automatic model selection",
                  selected: mode === "intelligent",
                  onSelect: () => void choose("intelligent"),
                },
                {
                  id: "workflow-private",
                  label: "Private",
                  icon: <Shield className="h-4 w-4" />,
                  badge: "Beta",
                  description: "Confidential AI",
                  selected: mode === "private",
                  onSelect: () => void choose("private"),
                },
              ]
            : []
        }
        popoverFooter={
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              Applies to new chats and workflow updates. Custom presets use your
              configured provider.
            </p>
            {mode === "private" && (
              <ConfidentialVerificationDetails
                current={verification}
                showLabel
              />
            )}
          </div>
        }
      />
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
