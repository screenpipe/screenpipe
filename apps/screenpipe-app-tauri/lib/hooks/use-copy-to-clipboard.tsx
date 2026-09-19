"use client";

import { toast } from "@/components/ui/use-toast";
import { commands } from "@/lib/utils/tauri";
import * as React from "react";
import { useGT } from "gt-react";


export interface useCopyToClipboardProps {
  timeout?: number;
}

export function useCopyToClipboard({
  timeout = 2000,
}: useCopyToClipboardProps) {
  const ui = useGT();
  const [isCopied, setIsCopied] = React.useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (typeof window === "undefined") {
      return;
    }

    if (!value) {
      return;
    }

    commands.copyTextToClipboard(value).then(() => {
      setIsCopied(true);
      toast({
        title: ui("Copied to clipboard"),
        duration: 2000,
      });

      setTimeout(() => {
        setIsCopied(false);
      }, timeout);
    }).catch((error) => {
      console.error("failed to copy to clipboard:", error);
    });
  };

  return { isCopied, copyToClipboard };
}
