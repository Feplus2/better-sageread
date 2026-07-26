import type { UIMessage } from "ai";

export type ThreadScope = "global" | "book";

export interface Thread {
  id: string;
  book_id: string | null;
  title: string;
  metadata: string;
  messages: UIMessage[];
  starred: boolean;
  scope: ThreadScope;
  created_at: number;
  updated_at: number;
}

export interface RawThread {
  id: string;
  book_id: string | null;
  title: string;
  metadata: string;
  messages: string;
  starred: boolean;
  scope: ThreadScope;
  created_at: number;
  updated_at: number;
}

export interface ThreadSummary {
  id: string;
  book_id: string | null;
  title: string;
  message_count: number;
  starred: boolean;
  scope: ThreadScope;
  created_at: number;
  updated_at: number;
}
