/**
 * Development plan catalog, mirroring `PLAN_CATALOG` in
 * backend/app/services/billing.py. Prices are intentionally absent: the
 * backend ships development plans until commercial pricing is approved.
 * Authenticated pages should read live plans from `GET /api/v1/billing/plans`.
 */
export interface PlanLimits {
  max_users: number | null;
  max_catalog_items: number | null;
  max_statement_imports_per_month: number | null;
  max_ai_requests_per_month: number | null;
  max_storage_mb: number | null;
  advanced_reporting: boolean;
  ai_features: boolean;
}

export interface DevelopmentPlan {
  code: string;
  name: string;
  description: string;
  limits: PlanLimits;
  isDefault?: boolean;
}

export const DEVELOPMENT_PLANS: DevelopmentPlan[] = [
  {
    code: "dev-starter",
    name: "Starter",
    description: "Small catalogs and solo administrators.",
    limits: {
      max_users: 3,
      max_catalog_items: 500,
      max_statement_imports_per_month: 5,
      max_ai_requests_per_month: 50,
      max_storage_mb: 1024,
      advanced_reporting: false,
      ai_features: true,
    },
  },
  {
    code: "dev-professional",
    name: "Professional",
    description: "Independent publishers and labels.",
    isDefault: true,
    limits: {
      max_users: 10,
      max_catalog_items: 10000,
      max_statement_imports_per_month: 50,
      max_ai_requests_per_month: 500,
      max_storage_mb: 10240,
      advanced_reporting: true,
      ai_features: true,
    },
  },
  {
    code: "dev-business",
    name: "Business",
    description: "Growing rights teams with multiple administrators.",
    limits: {
      max_users: 50,
      max_catalog_items: 100000,
      max_statement_imports_per_month: 500,
      max_ai_requests_per_month: 5000,
      max_storage_mb: 102400,
      advanced_reporting: true,
      ai_features: true,
    },
  },
  {
    code: "dev-enterprise",
    name: "Enterprise",
    description: "Custom limits for large catalogs.",
    limits: {
      max_users: null,
      max_catalog_items: null,
      max_statement_imports_per_month: null,
      max_ai_requests_per_month: null,
      max_storage_mb: null,
      advanced_reporting: true,
      ai_features: true,
    },
  },
];

export const PLAN_LIMIT_ROWS: { key: keyof PlanLimits; label: string; format?: (value: number) => string }[] = [
  { key: "max_users", label: "Team members" },
  { key: "max_catalog_items", label: "Catalog items" },
  { key: "max_statement_imports_per_month", label: "Statement imports / month" },
  { key: "max_ai_requests_per_month", label: "AI requests / month" },
  {
    key: "max_storage_mb",
    label: "File storage",
    format: (value) => (value >= 1024 ? `${(value / 1024).toLocaleString()} GB` : `${value.toLocaleString()} MB`),
  },
  { key: "advanced_reporting", label: "Advanced reporting" },
  { key: "ai_features", label: "AI assistance" },
];
