import {
  Banknote,
  BarChart3,
  Building2,
  Calculator,
  CreditCard,
  Disc3,
  FileSignature,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  ListChecks,
  Library,
  Mic2,
  ScrollText,
  ShieldAlert,
  Sparkles,
  Split,
  Scale,
  Users,
  UsersRound,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Primary navigation. Every module is listed; routes owned by other teams
 * may not exist yet (they render the global 404 until shipped).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Catalog",
    items: [
      { label: "Catalog overview", href: "/catalog", icon: Library },
      { label: "Works", href: "/catalog/works", icon: FileText },
      { label: "Recordings", href: "/catalog/recordings", icon: Mic2 },
      { label: "Releases", href: "/catalog/releases", icon: Disc3 },
      { label: "Artists & contributors", href: "/catalog/parties", icon: UsersRound },
    ],
  },
  {
    label: "Rights",
    items: [
      { label: "Rights overview", href: "/rights", icon: Scale },
      { label: "Conflicts", href: "/rights/conflicts", icon: ShieldAlert },
      { label: "Split sheets", href: "/rights/split-sheets", icon: Split },
    ],
  },
  {
    label: "Contracts",
    items: [{ label: "Contracts", href: "/contracts", icon: FileSignature }],
  },
  {
    label: "Royalties",
    items: [
      { label: "Statements", href: "/royalties/statements", icon: FileSpreadsheet },
      { label: "Processing", href: "/royalties/runs", icon: Calculator },
      { label: "Reports", href: "/royalties/reports", icon: BarChart3 },
    ],
  },
  {
    label: "Payouts",
    items: [
      { label: "Payouts", href: "/payouts", icon: Banknote },
      { label: "Payees", href: "/payouts/payees", icon: Wallet },
    ],
  },
  {
    label: "Intelligence",
    items: [{ label: "AI assistant", href: "/ai", icon: Sparkles }],
  },
  {
    label: "Admin",
    items: [
      { label: "Team", href: "/settings/team", icon: Users },
      { label: "Organization", href: "/settings/organization", icon: Building2 },
      { label: "Billing", href: "/settings/billing", icon: CreditCard },
      { label: "Background jobs", href: "/settings/jobs", icon: ListChecks },
      { label: "Automation", href: "/settings/automation", icon: Workflow },
      { label: "Audit log", href: "/settings/audit", icon: ScrollText },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Longest matching href wins so `/catalog` is not active on `/catalog/works`. */
export function activeNavHref(pathname: string, items: NavItem[] = ALL_NAV_ITEMS): string | null {
  let best: string | null = null;
  for (const item of items) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.length) best = item.href;
    }
  }
  return best;
}
