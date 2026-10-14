import { errorMessage, isApiError, validationIssues } from "@/lib/api/errors";

/**
 * Maps a contract save error to form fields. Nested 422 locations become
 * `parties.<i>` / `terms.<i>` / `assets`, and known business codes are
 * attached to the field they concern. Anything else becomes a form error.
 */
export function contractFormErrors(error: unknown): { fields: Record<string, string>; form: string | null } {
  const fields: Record<string, string> = {};
  if (!isApiError(error)) return { fields, form: errorMessage(error) };
  switch (error.code) {
    case "duplicate_reference":
      return { fields: { reference: error.message }, form: null };
    case "invalid_status_transition":
      return { fields: { status: error.message }, form: error.message };
    case "contract_end_date_passed":
      return { fields: { end_date: error.message }, form: error.message };
    case "invalid_dates":
      return { fields: { end_date: error.message }, form: null };
  }
  const issues = validationIssues(error);
  for (const issue of issues) {
    const loc = issue.loc[0] === "body" ? issue.loc.slice(1) : issue.loc;
    let key: string;
    if (loc[0] === "parties" && loc.length > 1) key = `parties.${loc[1]}`;
    else if (loc[0] === "royalty_terms" && loc.length > 1) key = `terms.${loc[1]}`;
    else if (loc[0] === "assets") key = "assets";
    else key = loc[0] ?? "";
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  const unmapped = issues.length === 0 || Object.keys(fields).length === 0;
  return { fields, form: unmapped ? errorMessage(error) : null };
}
