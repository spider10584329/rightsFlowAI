"use client";

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, FileWarning, FolderInput, History, Inbox, KeyRound, RotateCw, Siren, Workflow } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AutomationOverviewCards, EventsPanel, RunsPanel } from "@/components/automation/automation-activity";
import { automationAccess } from "@/components/automation/automation-format";
import { KeysPanel } from "@/components/automation/automation-keys";
import { InboxFilesPanel } from "@/components/automation/inbox-files-panel";
import { IncidentsPanel } from "@/components/automation/incidents-panel";
import { ManagedAutomationsPanel } from "@/components/automation/managed-automations";
import { ReviewQueue } from "@/components/automation/review-queue";
import { StatementsPanel } from "@/components/automation/statements-panel";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { automationKeys, useManagedAutomations } from "@/lib/api/hooks/automation";

// Managed mode (deployments): RightsFlow runs n8n; admins switch automations on
// and off. Self-hosted mode (development): an operator connects a local n8n
// with hand-made keys and the inbox folder.
const MANAGED_TABS = ["automations", "runs", "review", "statements", "incidents", "events", "keys"] as const;
const SELF_HOSTED_TABS = ["review", "statements", "incidents", "inbox", "keys", "runs", "events"] as const;
type AdminTab = (typeof MANAGED_TABS)[number] | (typeof SELF_HOSTED_TABS)[number];

export function AutomationClient() {
  const { org } = useOrg();
  const access = automationAccess(org.role);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const managedQuery = useManagedAutomations(org.id, { enabled: access.admin });
  const managed = managedQuery.data?.mode === "managed";
  const legacyKeys = (managedQuery.data?.manual_keys ?? 0) > 0;

  const allowed: readonly AdminTab[] = managed ? MANAGED_TABS.filter((tab) => tab !== "keys" || legacyKeys) : SELF_HOSTED_TABS;
  const defaultTab: AdminTab = managed ? "automations" : "review";
  const requested = searchParams.get("tab");
  const tab: AdminTab = access.admin && allowed.includes(requested as AdminTab) ? (requested as AdminTab) : defaultTab;

  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === defaultTab) params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const refreshing = useIsFetching({ queryKey: automationKeys.all(org.id) }) > 0;

  const header = (
    <PageHeader
      title="Automation"
      description={
        managed
          ? "Automations that process statements, send reminders, run AI reviews and prepare monthly reports. RightsFlow runs them for you; everything they find waits for a person."
          : "n8n workflows that import statements, check processing, send reminders and request AI reviews. Everything they find waits for a person."
      }
      breadcrumbs={[{ label: "Admin" }, { label: "Automation" }]}
      actions={
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RotateCw aria-hidden />}
          loading={refreshing}
          onClick={() => void queryClient.invalidateQueries({ queryKey: automationKeys.all(org.id) })}
        >
          Refresh
        </Button>
      }
    />
  );

  if (!access.admin) {
    return (
      <>
        {header}
        <div className="space-y-4">
          <ReviewQueue orgId={org.id} canAct={access.actOnQueue} />
          <StatementsPanel orgId={org.id} canAct={access.actOnQueue} />
          <Alert tone="info" title="Automation is admin-managed">
            Admins choose which automations run and can see run history, incidents and the event outbox.
            {access.actOnQueue
              ? " As a manager you can resolve or dismiss review tasks, retry statements automation stopped on and request automated reviews from catalog and conflict pages."
              : null}
          </Alert>
        </div>
      </>
    );
  }

  if (managedQuery.isLoading) {
    return (
      <>
        {header}
        <Skeleton className="mb-6 h-24 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </>
    );
  }

  if (managed) {
    const automationsOn = managedQuery.data?.automations.filter((automation) => automation.enabled).length ?? 0;
    return (
      <>
        {header}
        <AutomationOverviewCards orgId={org.id} automationsOn={automationsOn} />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="automations">
              <Workflow aria-hidden /> Automations
            </TabsTrigger>
            <TabsTrigger value="runs">
              <History aria-hidden /> Runs
            </TabsTrigger>
            <TabsTrigger value="review">
              <ClipboardCheck aria-hidden /> Review queue
            </TabsTrigger>
            <TabsTrigger value="statements">
              <FileWarning aria-hidden /> Statements
            </TabsTrigger>
            <TabsTrigger value="incidents">
              <Siren aria-hidden /> Incidents
            </TabsTrigger>
            <TabsTrigger value="events">
              <Inbox aria-hidden /> Outbox
            </TabsTrigger>
            {legacyKeys ? (
              <TabsTrigger value="keys">
                <KeyRound aria-hidden /> Old keys
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="automations">
            <ManagedAutomationsPanel
              orgId={org.id}
              data={managedQuery.data}
              isLoading={managedQuery.isLoading}
              error={managedQuery.error}
              onRetry={() => void managedQuery.refetch()}
            />
          </TabsContent>
          <TabsContent value="runs">
            <RunsPanel orgId={org.id} />
          </TabsContent>
          <TabsContent value="review">
            <ReviewQueue orgId={org.id} canAct={access.actOnQueue} />
          </TabsContent>
          <TabsContent value="statements">
            <StatementsPanel orgId={org.id} canAct={access.actOnQueue} />
          </TabsContent>
          <TabsContent value="incidents">
            <IncidentsPanel orgId={org.id} />
          </TabsContent>
          <TabsContent value="events">
            <EventsPanel orgId={org.id} />
          </TabsContent>
          {legacyKeys ? (
            <TabsContent value="keys">
              <KeysPanel orgId={org.id} legacy />
            </TabsContent>
          ) : null}
        </Tabs>
      </>
    );
  }

  return (
    <>
      {header}
      <AutomationOverviewCards orgId={org.id} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="review">
            <ClipboardCheck aria-hidden /> Review queue
          </TabsTrigger>
          <TabsTrigger value="statements">
            <FileWarning aria-hidden /> Statements
          </TabsTrigger>
          <TabsTrigger value="incidents">
            <Siren aria-hidden /> Incidents
          </TabsTrigger>
          <TabsTrigger value="inbox">
            <FolderInput aria-hidden /> Inbox files
          </TabsTrigger>
          <TabsTrigger value="keys">
            <KeyRound aria-hidden /> Keys
          </TabsTrigger>
          <TabsTrigger value="runs">
            <History aria-hidden /> Runs
          </TabsTrigger>
          <TabsTrigger value="events">
            <Inbox aria-hidden /> Outbox
          </TabsTrigger>
        </TabsList>
        <TabsContent value="review">
          <ReviewQueue orgId={org.id} canAct={access.actOnQueue} />
        </TabsContent>
        <TabsContent value="statements">
          <StatementsPanel orgId={org.id} canAct={access.actOnQueue} />
        </TabsContent>
        <TabsContent value="incidents">
          <IncidentsPanel orgId={org.id} />
        </TabsContent>
        <TabsContent value="inbox">
          <InboxFilesPanel orgId={org.id} />
        </TabsContent>
        <TabsContent value="keys">
          <KeysPanel orgId={org.id} />
        </TabsContent>
        <TabsContent value="runs">
          <RunsPanel orgId={org.id} />
        </TabsContent>
        <TabsContent value="events">
          <EventsPanel orgId={org.id} />
        </TabsContent>
      </Tabs>
    </>
  );
}
