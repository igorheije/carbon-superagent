"use client";

import type { EngineState } from "@/lib/domain/types";

/**
 * One live (SSE) connection per browser, shared by every tab of the same project.
 *
 * Browsers cap HTTP/1.1 at 6 connections per host. With one EventSource per tab, the 7th tab
 * (or an F5 while others are open) could not even load. Here a single "leader" tab holds the
 * EventSource (elected with the Web Locks API) and relays frames to the other tabs through a
 * BroadcastChannel. When the leader closes, the lock is released and another tab takes over.
 */

type Message =
  | { readonly type: "snapshot"; readonly snapshot: EngineState }
  | { readonly type: "status"; readonly connected: boolean }
  | { readonly type: "hello" };

export interface LiveHandlers {
  readonly onSnapshot: (snapshot: EngineState) => void;
  readonly onStatus: (connected: boolean) => void;
}

const RECONNECT_MS = 3000;

export function subscribeLive(projectId: string, handlers: LiveHandlers): () => void {
  const name = `carbon-live:${projectId}`;
  const hasChannel = typeof BroadcastChannel !== "undefined";
  const channel = hasChannel ? new BroadcastChannel(name) : null;
  let isDisposed = false;
  let isLeader = false;
  let last: EngineState | null = null;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let releaseLock: (() => void) | null = null;

  const post = (message: Message) => channel?.postMessage(message);

  if (channel) {
    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.type === "snapshot" && !isLeader) {
        last = message.snapshot;
        handlers.onSnapshot(message.snapshot);
        handlers.onStatus(true);
      } else if (message.type === "status" && !isLeader) {
        handlers.onStatus(message.connected);
      } else if (message.type === "hello" && isLeader && last) {
        post({ type: "snapshot", snapshot: last });
      }
    };
  }

  const connect = () => {
    if (isDisposed) return;
    source = new EventSource("/api/stream");
    source.onopen = () => {
      handlers.onStatus(true);
      post({ type: "status", connected: true });
    };
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as EngineState;
        last = snapshot;
        handlers.onSnapshot(snapshot);
        post({ type: "snapshot", snapshot });
      } catch {
        // malformed frame: the next snapshot replaces it
      }
    };
    source.onerror = () => {
      handlers.onStatus(false);
      post({ type: "status", connected: false });
      source?.close();
      source = null;
      if (!isDisposed) retry = setTimeout(connect, RECONNECT_MS);
    };
  };

  const becomeLeader = () => {
    if (isDisposed) return;
    isLeader = true;
    connect();
  };

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks && channel) {
    void locks
      .request(name, () => {
        becomeLeader();
        // Hold the lock for the tab's lifetime (or until this subscription is disposed).
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
          if (isDisposed) resolve();
        });
      })
      .catch(() => undefined);
    // Ask an existing leader for its latest frame so a new tab paints immediately.
    post({ type: "hello" });
  } else {
    // Old browsers: no sharing, one connection per tab (previous behavior).
    becomeLeader();
  }

  return () => {
    isDisposed = true;
    if (retry) clearTimeout(retry);
    source?.close();
    releaseLock?.();
    channel?.close();
  };
}
