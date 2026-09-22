// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { MessageCircle, ArrowUpRight } from "lucide-react";
import type { WorkflowMap } from "./model";
import styles from "./workflow-question.module.css";

export function WorkflowQuestion({ workflow, question, stage, interactive }: {
  workflow: WorkflowMap; question: string; stage?: string; interactive: boolean;
}) {
  if (!interactive) return <span>{question}</span>;
  return <button type="button" className={styles.question} title="Discuss in chat"
    onClick={() => window.dispatchEvent(new CustomEvent("workflows:feedback", { detail: {
      key: `feedback:${workflow.id || workflow.title}`, title: workflow.title,
      workflow, purpose: "feedback", question: stage ? `${stage}\n\n${question}` : question,
    } }))}>
    <MessageCircle size={14} aria-hidden="true" /><span>{question}</span><ArrowUpRight size={14} aria-hidden="true" />
  </button>;
}
