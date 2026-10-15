import type { AiMessage } from '@wikistow/client';
import { Link, useLocation } from '@tanstack/react-router';
import { Copy, Puzzle, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { chatStore, useChatStore } from '../ai/chat';
import { toolActivity, toolResults } from '../ai/chat-model';
import { Working } from '../ai/working';
import { useClient } from '../vault/store';
import type { WorkshopChat } from './workshop-chat';

/** Where a workshop's conversation goes, for anyone about to send one. */
export function WorkshopDisclosure({ host }: { host: string }) {
  return (
    <div className="grid gap-1.5 text-sm text-muted-foreground">
      <p>
        In the workshop, your messages, the plugin’s files, its sample pages and what its preview
        shows go through your WikiStow server to the AI provider at{' '}
        <strong className="text-foreground">{host}</strong>. None of your pages goes unless you copy
        it into the preview.
      </p>
      <p>
        The workshop lasts until you end it, lock your vault, sign out, or reload or close the app.
        Export or install the plugin first to keep it.
      </p>
    </div>
  );
}

/**
 * The workshop's conversation, in the assistant's panel: the model's words
 * and what its tools did. The page on screen can be copied into the
 * preview, and only that copy is shared.
 */
export function WorkshopConversation({
  chat,
  provider,
}: {
  chat: WorkshopChat;
  provider: { host: string; model: string };
}) {
  const { session } = chat;
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const ai = useSyncExternalStore(subscribe, session.state);
  const turns = useSyncExternalStore(chat.subscribe, chat.turns);
  const onWorkshop = useLocation({ select: (location) => location.pathname === '/workshop' });
  const end = useRef<HTMLDivElement>(null);
  // Braces: Chromium's scrollIntoView now answers a promise, which isn't a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [ai.messages]);
  const results = toolResults(ai.messages);
  let turn = 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          <Puzzle className="mr-1 inline size-3.5" strokeWidth={1.75} />
          <strong className="text-foreground">Plugin workshop</strong>
        </span>
        <span>
          {provider.model} at {provider.host}
        </span>
        <span className="ml-auto flex gap-3">
          {!onWorkshop && (
            <Link to="/workshop" className="font-bold text-primary hover:underline">
              Open the preview
            </Link>
          )}
          <button
            type="button"
            onClick={() => chatStore.end()}
            className="font-bold text-primary hover:underline"
          >
            End workshop
          </button>
        </span>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 py-3">
        {ai.messages.length === 0 && <WorkshopDisclosure host={provider.host} />}
        {ai.messages.map((message, index) => {
          if (message.role === 'user') {
            const sent = turns[turn++];
            return (
              <div key={index} className="grid justify-items-end gap-1">
                {sent?.copied && (
                  <span className="text-xs text-muted-foreground">
                    Copied “<Name>{sent.copied}</Name>” into the preview
                  </span>
                )}
                <p className="max-w-[90%] rounded-card bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                  {sent?.text ?? message.text}
                </p>
              </div>
            );
          }
          if (message.role === 'assistant') {
            return <Reply key={index} message={message} results={results} />;
          }
          return null;
        })}
        {ai.finish === 'stopped' && (
          <p role="status" className="text-xs text-muted-foreground">
            Stopped. A build it had started makes no version and previews nothing.
          </p>
        )}
        {ai.failure && (
          <p role="alert" className="text-sm text-destructive">
            {ai.failure.message}
          </p>
        )}
        <div ref={end} />
      </div>
      <Composer chat={chat} running={ai.status === 'running'} />
    </div>
  );
}

/** The model's words, as plain text, and a line for each tool it ran. */
function Reply({
  message,
  results,
}: {
  message: Extract<AiMessage, { role: 'assistant' }>;
  results: ReturnType<typeof toolResults>;
}) {
  return (
    <div className="grid gap-1.5">
      {message.text.trim() && <p className="text-sm whitespace-pre-wrap">{message.text}</p>}
      {message.toolCalls.map((call) => {
        const result = results.get(call.id);
        return (
          <p key={call.id} className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>{result ? (result.isError ? '✕' : '✓') : '…'}</span>
            <span className={cn(result?.isError && 'text-destructive')}>
              {toolActivity(call.name, call.input)}
              {result?.isError && `: ${result.output}`}
            </span>
          </p>
        );
      })}
    </div>
  );
}

/** The message box, offering to copy the page on screen into the preview. */
function Composer({ chat, running }: { chat: WorkshopChat; running: boolean }) {
  const ctx = useClient();
  const { page } = useChatStore();
  const [text, setText] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const message = text.trim();
    if (!message || running) return;
    setError(null);
    setText('');
    setCopied(null);
    try {
      await chat.send(message);
    } catch (caught) {
      setText(message);
      setError(caught instanceof Error ? caught.message : 'Couldn’t send that.');
    }
  };
  const copy = async () => {
    if (!page) return;
    setError(null);
    try {
      await chat.copyPage(ctx, page);
      setCopied(page.pageId);
    } catch {
      setError('Couldn’t copy that page.');
    }
  };
  return (
    <form
      className="grid gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {page && (
        <button
          type="button"
          disabled={copied === page.pageId}
          onClick={() => void copy()}
          className={cn(
            'flex w-fit max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
            copied === page.pageId
              ? 'border-primary bg-primary/10 font-bold text-primary'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          <Copy className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {copied === page.pageId ? 'Copied' : 'Copy'} “<Name>{page.title}</Name>” into the
            preview
          </span>
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Working working={running} />
      <div className="flex items-end gap-2">
        {/* 16px on phones: iOS zooms in on a smaller field when it's focused. */}
        <textarea
          aria-label="Message"
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Describe the plugin, or what to change"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-control border border-input bg-background px-3 py-2 text-base outline-ring focus-visible:outline-2 md:text-sm"
        />
        {running ? (
          <Button type="button" variant="secondary" onClick={() => chat.stop()}>
            <Square strokeWidth={1.75} /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!text.trim()}>
            Send
          </Button>
        )}
      </div>
    </form>
  );
}
