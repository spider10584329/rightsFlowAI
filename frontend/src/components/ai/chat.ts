import type { AssistantResponse, ChatTurn } from "@/lib/api/hooks/ai";

export const MAX_HISTORY_TURNS = 10;
export const MAX_TURN_CHARS = 4000;
export const MIN_QUESTION_CHARS = 2;
export const MAX_QUESTION_CHARS = 2000;

export type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; response: AssistantResponse }
  | { id: string; role: "error"; question: string; error: unknown };

/**
 * The history sent with the next question: the last 10 user/assistant turns
 * (failed attempts excluded), each trimmed to the backend's 4000-char limit.
 */
export function buildHistory(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    if (message.role === "error") continue;
    const content = message.content.trim().slice(0, MAX_TURN_CHARS);
    if (!content) continue;
    turns.push({ role: message.role, content });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/** Mirrors the backend rule: 2..2000 characters after trimming. */
export function validateQuestion(question: string): string | null {
  const trimmed = question.trim();
  if (trimmed.length < MIN_QUESTION_CHARS) return "Ask a question of at least 2 characters.";
  if (trimmed.length > MAX_QUESTION_CHARS) return `Keep questions under ${MAX_QUESTION_CHARS.toLocaleString()} characters.`;
  return null;
}
