import type { ReactNode } from "react";

export function AuthHeading({ title, description, icon }: { title: ReactNode; description?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-8 space-y-2">
      {icon ? (
        <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-border bg-surface text-primary shadow-sm [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
      {description ? <p className="text-sm leading-relaxed text-fg-muted">{description}</p> : null}
    </div>
  );
}
