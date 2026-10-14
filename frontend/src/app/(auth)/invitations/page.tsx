import { redirect } from "next/navigation";

// Older invitation notifications linked to /invitations; pending invitations
// are listed on /onboarding (audit UI-01).
export default function InvitationsPage() {
  redirect("/onboarding");
}
