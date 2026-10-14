"use client";

import { AlertTriangle, Bot, Eraser, Send, User } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { AdvisoryLabel, AiErrorAlert, EntityBadge, ManagerOnlyNotice, RecordLink } from "@/components/ai/ai-ui";
import { buildHistory, MAX_HISTORY_TURNS, MAX_QUESTION_CHARS, validateQuestion, type ChatMessage } from "@/components/ai/chat";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useAssistant } from "@/lib/api/hooks/ai";
import { cn } from "@/lib/utils";

const STARTERS = [
  "Which works are missing an ISWC?",
  "Which recordings have no linked work?",
  "Who are the writers on our most recent works?",
];

let messageSeq = 0;
const nextId = () => `m${(messageSeq += 1)}`;

export function AssistantPanel({ orgId, canRun, configured }: { orgId: string; canRun: boolean; configured: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const assistant = useAssistant(orgId);
  const logRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, assistant.isPending]);

  if (!canRun) return <ManagerOnlyNotice feature="The catalog assistant" />;

  const ask = (raw: string) => {
    const problem = validateQuestion(raw);
    setValidation(problem);
    if (problem || assistant.isPending) return;
    const question = raw.trim();
    const history = buildHistory(messages);
    setMessages((current) => [...current, { id: nextId(), role: "user", content: question }]);
    setDraft("");
    assistant.mutate(
      { question, history },
      {
        onSuccess: (response) =>
          setMessages((current) => [...current, { id: nextId(), role: "assistant", content: response.answer, response }]),
        onError: (error) => setMessages((current) => [...current, { id: nextId(), role: "error", question, error }]),
      },
    );
  };

  /** Drops the failed attempt (error + the question right before it) and asks again. */
  const retry = (question: string, id: string) => {
    if (assistant.isPending) return;
    const index = messages.findIndex((message) => message.id === id);
    const remaining = messages.filter((_, position) => position !== index && position !== index - 1);
    const history = buildHistory(remaining);
    setMessages([...remaining, { id: nextId(), role: "user", content: question }]);
    assistant.mutate(
      { question, history },
      {
        onSuccess: (response) =>
          setMessages((current) => [...current, { id: nextId(), role: "assistant", content: response.answer, response }]),
        onError: (error) => setMessages((current) => [...current, { id: nextId(), role: "error", question, error }]),
      },
    );
  };

  return (
    <Card className="flex min-h-[32rem] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-fg">Catalog assistant</h2>
          <p className="text-xs text-fg-subtle">
            Answers are grounded in your catalog records. The conversation stays in this browser tab; the last {MAX_HISTORY_TURNS} turns are sent as context.
          </p>
        </div>
        {messages.length > 0 ? (
          <Button variant="ghost" size="sm" leftIcon={<Eraser aria-hidden />} onClick={() => setMessages([])} disabled={assistant.isPending}>
            Clear conversation
          </Button>
        ) : null}
      </div>

      <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-5 py-4" style={{ maxHeight: "36rem" }}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-fg">
              <Bot className="size-5" aria-hidden />
            </span>
            <p className="text-sm font-semibold text-fg">Ask about your catalog</p>
            <p className="max-w-md text-[13px] text-fg-muted">
              The assistant cites the works, recordings, releases, parties and contracts it used. When your data doesn&apos;t answer the question it says so.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {STARTERS.map((starter) => (
                <Button key={starter} size="xs" variant="outline" onClick={() => ask(starter)} disabled={!configured}>
                  {starter}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="flex justify-end gap-2">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-[13px] text-primary-fg">{message.content}</p>
                <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-muted" aria-hidden>
                  <User className="size-3.5" />
                </span>
                <span className="sr-only">You asked</span>
              </div>
            );
          }
          if (message.role === "error") {
            return (
              <div key={message.id} className="pl-9">
                <AiErrorAlert error={message.error} onRetry={() => retry(message.question, message.id)} />
              </div>
            );
          }
          const { response } = message;
          return (
            <div key={message.id} className="flex gap-2">
              <span className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg" aria-hidden>
                <Bot className="size-3.5" />
              </span>
              <div className="min-w-0 max-w-[90%] space-y-3 rounded-2xl rounded-tl-sm border border-border bg-surface-2/60 px-4 py-3">
                {response.insufficient_data ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning-soft-fg">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    Insufficient data: your records don&apos;t contain enough information to answer this fully.
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{response.answer}</p>
                {response.cited_records.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Cited records</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {response.cited_records.map((record) => (
                        <li key={`${record.entity_type}-${record.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <EntityBadge entityType={record.entity_type} />
                          <RecordLink entityType={record.entity_type} id={record.id}>
                            {record.title ?? record.id}
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {response.dropped_citations > 0 ? (
                  <p className="text-2xs text-fg-subtle">
                    {response.dropped_citations} citation{response.dropped_citations === 1 ? " was" : "s were"} removed because they didn&apos;t match a record in your organization.
                  </p>
                ) : null}
                {response.follow_up_questions.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Follow-up questions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {response.follow_up_questions.map((question) => (
                        <Button key={question} size="xs" variant="soft" onClick={() => ask(question)} disabled={assistant.isPending}>
                          {question}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <AdvisoryLabel provider={response.provider} model={response.model} />
                <p className="text-2xs text-fg-subtle">Based on {response.context_records} records retrieved from your catalog.</p>
              </div>
            </div>
          );
        })}
        {assistant.isPending ? (
          <div className="flex items-center gap-2 pl-9 text-[13px] text-fg-muted" role="status">
            <span className="flex gap-1" aria-hidden>
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle" />
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:150ms]" />
              <span className="size-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:300ms]" />
            </span>
            Searching your catalog and drafting an answer…
          </div>
        ) : null}
      </div>

      <form
        className="border-t border-border px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Ask the catalog assistant
        </label>
        <div className="flex items-end gap-2">
          <Textarea
            id={inputId}
            rows={2}
            value={draft}
            maxLength={MAX_QUESTION_CHARS}
            placeholder={configured ? "Ask about works, recordings, rights or contracts…" : "AI provider not configured"}
            disabled={!configured}
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? `${inputId}-error` : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                ask(draft);
              }
            }}
            className="min-h-[2.75rem] flex-1 resize-none"
          />
          <Button type="submit" loading={assistant.isPending} disabled={!configured} leftIcon={<Send aria-hidden />}>
            Ask
          </Button>
        </div>
        <div className="mt-1 flex justify-between text-2xs text-fg-subtle">
          {validation ? (
            <span id={`${inputId}-error`} role="alert" className={cn("font-medium text-danger")}>
              {validation}
            </span>
          ) : (
            <span>Enter to send · Shift+Enter for a new line</span>
          )}
          <span>
            {draft.length.toLocaleString()} / {MAX_QUESTION_CHARS.toLocaleString()}
          </span>
        </div>
      </form>
    </Card>
  );
}
