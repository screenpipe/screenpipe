// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { createContext, type Dispatch, type SetStateAction } from "react";
import type { AssistantContext, WorkflowsAssistantPlatform } from "./assistant";

/** A mounted page can supply an action to the existing chat without another composer. */
export type PageAssistant = {
  context: AssistantContext;
  promptRequest?: { id: string; text: string };
  ask: WorkflowsAssistantPlatform["ask"];
};
export const PageAssistantContext = createContext<Dispatch<SetStateAction<PageAssistant | null>> | null>(null);
