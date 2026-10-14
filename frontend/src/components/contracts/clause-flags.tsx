import { Bot, ListChecks } from "lucide-react";

import { SeverityBadge } from "@/components/rights/badges";
import { Badge } from "@/components/ui/badge";
import { titleCase } from "@/lib/utils";

export interface ClauseFlagLike {
  category?: unknown;
  severity?: unknown;
  excerpt?: unknown;
  explanation?: unknown;
  source?: unknown;
  match?: unknown;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Groups flags by category, most severe first. */
export function groupFlags(flags: ClauseFlagLike[]): { category: string; severity: string; items: ClauseFlagLike[] }[] {
  const groups = new Map<string, ClauseFlagLike[]>();
  for (const flag of flags) {
    const category = String(flag.category ?? "other");
    groups.set(category, [...(groups.get(category) ?? []), flag]);
  }
  return [...groups.entries()]
    .map(([category, items]) => {
      const severity = items.map((item) => String(item.severity ?? "low")).sort((a, b) => (SEVERITY_ORDER[a] ?? 9) - (SEVERITY_ORDER[b] ?? 9))[0];
      return { category, severity, items };
    })
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.category.localeCompare(b.category));
}

export function ClauseFlagList({ flags, emptyText = "No clauses flagged." }: { flags: ClauseFlagLike[]; emptyText?: string }) {
  if (flags.length === 0) return <p className="text-[13px] text-fg-subtle">{emptyText}</p>;
  return (
    <ul className="space-y-3">
      {groupFlags(flags).map((group) => (
        <li key={group.category} className="rounded-lg border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/50 px-3.5 py-2">
            <span className="text-[13px] font-semibold">{titleCase(group.category)}</span>
            <SeverityBadge severity={group.severity} />
            <span className="text-xs text-fg-subtle">
              {group.items.length} {group.items.length === 1 ? "excerpt" : "excerpts"}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {group.items.map((flag, index) => (
              <li key={index} className="space-y-1.5 px-3.5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  {flag.source === "ai" ? (
                    <Badge tone="accent" className="gap-1">
                      <Bot className="size-3" aria-hidden /> AI flag
                    </Badge>
                  ) : (
                    <Badge tone="neutral" className="gap-1">
                      <ListChecks className="size-3" aria-hidden /> Rule match
                    </Badge>
                  )}
                  {group.items.length > 1 ? <SeverityBadge severity={String(flag.severity ?? "low")} /> : null}
                  {flag.match ? <span className="font-mono text-2xs text-fg-subtle">matched “{String(flag.match)}”</span> : null}
                </div>
                {flag.excerpt ? <blockquote className="border-l-2 border-border-strong pl-3 text-fg-muted">{String(flag.excerpt)}</blockquote> : null}
                {flag.explanation ? <p className="text-xs text-fg-muted">{String(flag.explanation)}</p> : null}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
