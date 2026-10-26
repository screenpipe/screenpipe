// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown, FilterX, LayoutGrid, List } from "lucide-react";
import { WorkflowAppIcons } from "./workflow-map-app-icon";
import styles from "./workflow-collection.module.css";

export { WorkflowSearch, readWorkflowFilters, type WorkflowFilterOption } from "./workflow-search";
export type WorkflowCollectionView = "cards" | "list";

/** Shared by the Enterprise Studio and the desktop catalog. Data stays in adapters. */
export function WorkflowCollectionToolbar({ search, reset, count, order, onOrderChange, sortDescription, sortOptions, view, onViewChange }: {
  search: ReactNode; reset?: () => void; count: number; order: string;
  onOrderChange: (value: string) => void; sortDescription?: string;
  sortOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  view: WorkflowCollectionView; onViewChange: (value: WorkflowCollectionView) => void;
}) {
  return <div className={`${styles.theme} ${styles.toolbar}`}>
    <div className={styles.searchArea}>{search}{reset && <button type="button" onClick={reset} aria-label="Reset" title="Reset filters" className={styles.reset}><FilterX size={16} aria-hidden="true" /></button>}</div>
    <div className={styles.controls}>
      <span className={styles.count}>{count} workflows</span>
      <div className={styles.controlGroup}>
        <label className={styles.sort}><span className={styles.sortLabel}>Sort:</span>
          <select aria-label="Sort workflows" title={sortDescription} aria-description={sortDescription} value={order} onChange={event => onOrderChange(event.target.value)}>
            {sortOptions.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
          </select><ChevronDown className={styles.chevron} aria-hidden="true" />
        </label>
        <div role="group" aria-label="Workflow collection view" className={styles.viewButtons}>
          {([["cards", LayoutGrid, "Cards"], ["list", List, "List"]] as const).map(([value, Icon, label]) => <button key={value} type="button" aria-label={label} title={label} aria-pressed={view === value} onClick={() => onViewChange(value)}><Icon size={14} aria-hidden="true" /></button>)}
        </div>
      </div>
    </div>
  </div>;
}

export function WorkflowCard({ title, subtitle, details, confidence, metrics, apps, appIcons, review, ...button }: Omit<ComponentProps<"button">, "title" | "children" | "className" | "type"> & {
  title: string; subtitle?: ReactNode; details: ReactNode; confidence?: ReactNode;
  metrics?: ReactNode; apps: string[]; appIcons?: ReactNode; review: ReactNode;
}) {
  return <article className={`${styles.theme} ${styles.card}`}>
    <button {...button} type="button" className={styles.cardButton}>
      <span className={styles.cardTop}>
        <span className={styles.title} role="heading" aria-level={2}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        <span className={styles.details}>{details}</span>
        {confidence && <span className={styles.confidence}>{confidence}</span>}
      </span>
      {metrics}
      <span className={styles.cardFooter}><span className={styles.apps}>{appIcons ?? <WorkflowAppIcons apps={apps} />}</span><span>{review}</span></span>
    </button>
  </article>;
}

export function WorkflowListRow({ title, subtitle, details, confidence, apps, appIcons, review, savings, ...button }: Omit<ComponentProps<"button">, "title" | "children" | "className" | "type"> & {
  title: string; subtitle?: ReactNode; details: ReactNode; confidence?: ReactNode;
  apps: string[]; appIcons?: ReactNode; review: ReactNode; savings?: ReactNode;
}) {
  const icons = appIcons ?? <WorkflowAppIcons apps={apps} />;
  return <div className={`${styles.theme} ${styles.listItem}`}>
    <button {...button} type="button" className={styles.row}>
      <span className={styles.cardTop}><span className={styles.title} role="heading" aria-level={2}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        <span className={styles.details}>{details}</span>
        {confidence && <span className={styles.confidence}>{confidence}</span>}
      </span>
      <span className={styles.rowApps}>{icons}</span><span className={styles.rowReview}>{review}</span>
      {savings && <span className={styles.rowSavings}>{savings}</span>}
      <span className={styles.mobileRowFooter}><span className={styles.apps}>{icons}</span>{review}</span>
    </button>
  </div>;
}
