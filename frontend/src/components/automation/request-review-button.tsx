"use client";

import { Bot } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useRequestAutomatedReview, type ReviewSubjectType } from "@/lib/api/hooks/automation";

/**
 * Queues an automated (AI-assisted) review through the n8n outbox. Render only
 * for managers and above; results land in Settings → Automation → Review queue.
 */
export function RequestReviewButton({
  orgId,
  subjectType,
  subjectId,
  ...props
}: { orgId: string; subjectType: ReviewSubjectType; subjectId: string } & Omit<ButtonProps, "onClick" | "children" | "loading">) {
  const request = useRequestAutomatedReview(orgId);
  return (
    <Button
      variant="outline"
      leftIcon={<Bot aria-hidden />}
      loading={request.isPending}
      onClick={() =>
        request.mutate(
          { subject_type: subjectType, subject_id: subjectId },
          {
            onSuccess: () =>
              toast.success("Automated review requested", {
                description: "Findings will appear in the automation review queue once the workflow runs. Nothing is changed automatically.",
              }),
            onError: (error) => toast.error("Couldn't request a review", { description: errorMessage(error) }),
          },
        )
      }
      {...props}
    >
      Request automated review
    </Button>
  );
}
