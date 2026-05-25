"use client";

import { useEffect } from "react";
import { StandaloneChat } from "@/components/standalone-chat";
import { mountPiEventRouter } from "@/lib/stores/pi-event-router";

export default function ChatPage() {
  useEffect(() => {
    void mountPiEventRouter();
  }, []);

  return <StandaloneChat />;
}
