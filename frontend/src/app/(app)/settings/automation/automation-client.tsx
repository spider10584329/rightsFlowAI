"use client";

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, FileWarning, FolderInput, History, Inbox, KeyRound, RotateCw, Siren } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AutomationOverviewCards, EventsPanel, RunsPanel } from "@/components/automation/automation-activity";
import { automationAccess } from "@/components/automation/automation-format";
import { KeysPanel } from "@/components/automation/automation-keys";
import { InboxFilesPanel } from "@/components/automation/inbox-files-panel";
import { IncidentsPanel } from "@/components/automation/incidents-panel";
import { ReviewQueue } from "@/components/automation/review-queue";
import { StatementsPanel } from "@/components/automation/statements-panel";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { automationKeys } from "@/lib/api/hooks/automation";

const ADMIN_TABS = ["review", "statements", "incidents", "inbox", "keys", "runs", "events"] as const;
type AdminTab = (typeof ADMIN_TABS)[number];

export function AutomationClient() {
  const { org } = useOrg();
  const access = automationAccess(org.role);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const requested = searchParams.get("tab");
  const tab: AdminTab = access.admin && (ADMIN_TABS as readonly string[]).includes(requested ?? "") ? (requested as AdminTab) : "review";

  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "review") params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const refreshing = useIsFetching({ queryKey: automationKeys.all(org.id) }) > 0;

  return (
    <>
      <PageHeader
        title="Automation"
        description="n8n workflows that import statements, check processing, send reminders and request AI reviews. Everything they find waits for a person."
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
      {access.admin ? (
        <>
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
      ) : (
        <div className="space-y-4">
          <ReviewQueue orgId={org.id} canAct={access.actOnQueue} />
          <StatementsPanel orgId={org.id} canAct={access.actOnQueue} />
          <Alert tone="info" title="Automation keys are admin-managed">
            Admins create the API keys n8n uses and can see run history, incidents, inbox files and the event outbox.
            {access.actOnQueue
              ? " As a manager you can resolve or dismiss review tasks, retry statements automation stopped on and request automated reviews from catalog and conflict pages."
              : null}
          </Alert>
        </div>
      )}
    </>
  );
}
