"use client";

import { Activity, BarChart3, ClipboardCheck, Copy, FileBarChart, Inbox, MessageSquare, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import { AnomaliesPanel } from "@/components/ai/anomalies-panel";
import { AssistantPanel } from "@/components/ai/assistant-panel";
import { CompletenessPanel } from "@/components/ai/completeness-panel";
import { DuplicatesPanel } from "@/components/ai/duplicates-panel";
import { ReportPanel } from "@/components/ai/report-panel";
import { SearchPanel } from "@/components/ai/search-panel";
import { describeAiError } from "@/components/ai/errors";
import { AiStatusBanner } from "@/components/ai/status-banner";
import { SuggestionsPanel } from "@/components/ai/suggestions-panel";
import { UsagePanel } from "@/components/ai/usage-panel";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { useAIStatus, useCheckAIConnection } from "@/lib/api/hooks/ai";

const TABS: { value: string; label: string; icon: ReactNode; ai: boolean }[] = [
  { value: "assistant", label: "Assistant", icon: <MessageSquare aria-hidden />, ai: true },
  { value: "search", label: "Smart search", icon: <Search aria-hidden />, ai: true },
  { value: "suggestions", label: "Suggestions", icon: <Inbox aria-hidden />, ai: false },
  { value: "duplicates", label: "Duplicates", icon: <Copy aria-hidden />, ai: false },
  { value: "anomalies", label: "Anomalies", icon: <BarChart3 aria-hidden />, ai: false },
  { value: "completeness", label: "Completeness", icon: <ClipboardCheck aria-hidden />, ai: false },
  { value: "report", label: "Report summary", icon: <FileBarChart aria-hidden />, ai: true },
  { value: "usage", label: "Usage", icon: <Activity aria-hidden />, ai: false },
];

export function AiClient() {
  const { org, can } = useOrg();
  const canRun = can("manager");
  const status = useAIStatus(org.id);
  const checkConnection = useCheckAIConnection(org.id);
  const configured = Boolean(status.data?.configured);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const requested = searchParams.get("tab");
  const defaultTab = status.data && !status.data.configured ? "suggestions" : "assistant";
  const tab = TABS.some((entry) => entry.value === requested) ? (requested as string) : defaultTab;

  // Each tab owns its own list params (page, filters), so switching tabs starts clean.
  const setTab = (value: string) => router.replace(`${pathname}?tab=${value}`, { scroll: false });

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Rights intelligence grounded in your own records. AI output is advisory and never changes data without a human approving it."
        breadcrumbs={[{ label: "Intelligence" }, { label: "AI assistant" }]}
      />
      <div className="space-y-5">
        <AiStatusBanner
          status={status.data}
          isLoading={status.isLoading}
          error={status.error}
          onRetry={() => void status.refetch()}
          onOpenTab={setTab}
          canCheck={can("admin")}
          checking={checkConnection.isPending}
          onCheckConnection={() =>
            checkConnection.mutate(undefined, {
              onSuccess: () => toast.success("AI provider connected", { description: "A test request succeeded." }),
              onError: (error) => {
                const info = describeAiError(error);
                toast.error(info.title, { description: info.message });
              },
            })
          }
        />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="AI tools">
            {TABS.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.icon} {entry.label}
                {entry.ai && status.data && !configured ? (
                  <Badge tone="neutral" className="ml-0.5">
                    Off
                  </Badge>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Kept mounted so the conversation survives tab switches. */}
          <TabsContent value="assistant" forceMount className="data-[state=inactive]:hidden">
            <AssistantPanel orgId={org.id} canRun={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="search">
            <SearchPanel orgId={org.id} canRun={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="suggestions">
            <SuggestionsPanel orgId={org.id} canReview={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="duplicates">
            <DuplicatesPanel orgId={org.id} canRun={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="anomalies">
            <AnomaliesPanel orgId={org.id} canRun={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="completeness">
            <CompletenessPanel orgId={org.id} canEdit={canRun} />
          </TabsContent>
          <TabsContent value="report">
            <ReportPanel orgId={org.id} canRun={canRun} configured={configured} />
          </TabsContent>
          <TabsContent value="usage">
            <UsagePanel orgId={org.id} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
