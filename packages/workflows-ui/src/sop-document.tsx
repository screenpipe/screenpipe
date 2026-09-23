// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import type { ReactNode } from "react";
import { WorkflowRichText } from "./rich-text";
import styles from "./sop-document.module.css";

/** Shared document surface; storage, evidence access and publication stay in adapters. */
export function SopDocument({
  title,
  subtitle,
  content,
  onTitleChange,
  onContentChange,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  content?: string;
  onTitleChange?: (title: string) => void;
  onContentChange?: (content: string) => void;
  children?: ReactNode;
}) {
  return (
    <article className={styles.document} aria-label="SOP document">
      <header className={styles.heading}>
        <p className={styles.kind}>Standard operating procedure</p>
        {onTitleChange ? (
          <input
            className={styles.title}
            aria-label="SOP title"
            maxLength={300}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
          />
        ) : (
          <h1 className={styles.title}>{title}</h1>
        )}
        {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      </header>
      {content !== undefined && (
        <WorkflowRichText
          value={content}
          onChange={onContentChange}
          label="SOP text"
          maxLength={60000}
          fullDocument
        />
      )}
      {children}
    </article>
  );
}
