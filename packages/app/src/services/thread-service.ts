import type { RawThread, Thread, ThreadScope, ThreadSummary } from "@/types/thread";
import { invoke } from "@tauri-apps/api/core";
import type { UIMessage } from "ai";

export interface ThreadMetadata {
  semanticContext?: string;
  [key: string]: any;
}

export async function createThread(
  bookId: string | undefined,
  title: string,
  initialMessages: UIMessage[],
  scope: ThreadScope = "book",
): Promise<Thread> {
  try {
    const payload = {
      book_id: bookId,
      title,
      metadata: JSON.stringify({}),
      messages_json: JSON.stringify(initialMessages),
      scope,
    };

    const newThread: RawThread = await invoke("create_thread", { payload });

    const thread: Thread = {
      ...newThread,
      messages: JSON.parse(newThread.messages),
    };

    return thread;
  } catch (error) {
    console.error("Error creating thread:", error);
    throw new Error("Failed to create thread on the backend.");
  }
}

export interface EditThreadOptions {
  title?: string;
  metadata?: Record<string, any>;
  messages?: UIMessage[];
  starred?: boolean;
}

export async function editThread(threadId: string, options: EditThreadOptions): Promise<Thread> {
  try {
    const payload = {
      id: threadId,
      title: options.title,
      metadata: options.metadata ? JSON.stringify(options.metadata) : undefined,
      messages_json: options.messages ? JSON.stringify(options.messages) : undefined,
      starred: options.starred,
    };

    const updatedThread: RawThread = await invoke("edit_thread", { payload });

    const thread: Thread = {
      ...updatedThread,
      messages: JSON.parse(updatedThread.messages),
    };

    return thread;
  } catch (error) {
    console.error("Error editing thread:", error);
    throw new Error("Failed to edit thread on the backend.");
  }
}

export async function getLatestThreadBybookId(bookId: string | undefined, scope: ThreadScope): Promise<Thread | null> {
  try {
    const result: RawThread | null = await invoke("get_latest_thread_by_book_id", { bookId, scope });

    if (result) {
      const thread: Thread = {
        ...result,
        messages: JSON.parse(result.messages),
      };
      return thread;
    }

    return null;
  } catch (error) {
    console.error("Error getting latest thread by book key:", error);
    throw new Error("Failed to get latest thread from the backend.");
  }
}

export async function getThreadsBybookId(bookId: string | null): Promise<ThreadSummary[]> {
  try {
    const result: ThreadSummary[] = await invoke("get_threads_by_book_id", { bookId: bookId });
    return result;
  } catch (error) {
    console.error("Error getting threads by book key:", error);
    throw new Error("Failed to get threads from the backend.");
  }
}

export async function getAllThreads(): Promise<ThreadSummary[]> {
  try {
    const result: ThreadSummary[] = await invoke("get_all_threads");
    return result;
  } catch (error) {
    console.error("Error getting all threads:", error);
    throw new Error("Failed to get all threads from the backend.");
  }
}

export async function getGlobalThreads(): Promise<ThreadSummary[]> {
  try {
    const result: ThreadSummary[] = await invoke("get_global_threads");
    return result;
  } catch (error) {
    console.error("Error getting global threads:", error);
    throw new Error("Failed to get global threads from the backend.");
  }
}

export async function getThreadById(threadId: string): Promise<Thread> {
  try {
    const result: RawThread = await invoke("get_thread_by_id", { threadId });

    const thread: Thread = {
      ...result,
      messages: JSON.parse(result.messages),
    };

    return thread;
  } catch (error) {
    console.error("Error getting thread by id:", error);
    throw new Error("Failed to get thread from the backend.");
  }
}

export async function deleteThread(threadId: string): Promise<void> {
  try {
    await invoke("delete_thread", { threadId });
  } catch (error) {
    console.error("Error deleting thread:", error);
    throw new Error("Failed to delete thread from the backend.");
  }
}
