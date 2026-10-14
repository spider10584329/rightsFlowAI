import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Breadcrumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  /** Small element next to the title (e.g. a status badge). */
  meta?: ReactNode;
  className?: string;
}

export function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-fg-subtle">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1">
              {item.href && !last ? (
                <Link href={item.href} className="rounded transition-colors hover:text-fg">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn(last && "text-fg-muted")}>
                  {item.label}
                </span>
              )}
              {last ? null : <ChevronRight className="size-3" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, description, breadcrumbs, actions, meta, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          {meta}
        </div>
        {description ? <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
