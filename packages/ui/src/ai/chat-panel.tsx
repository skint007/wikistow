import { listAppAgents, type AiMessage, type AiSession, type IdentityId } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Bot, FileText, Plus, Puzzle, Sparkles, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Picker } from '@/components/ui/picker';
import { cn } from '@/lib/utils';
import { AddAgentDialog } from '../agents/add-agent-dialog';
import { PLAIN, useClient } from '../vault/store';
import { saveOpenDraft } from '../page/use-draft-session';
import { searchIndexChanged } from '../data/queries';
import { desktop } from '../desktop';
import { usePlugins } from '../plugins/runtime';
import { WorkshopChat } from '../workshop/workshop-chat';
import { WorkshopConversation } from '../workshop/workshop-panel';
import { AiDisclosure } from './ai-settings';
import {
  AgentChat,
  chatStore,
  labelOf,
  useChatStore,
  type ChatState,
  type PageRef,
  type ProposalItem,
} from './chat';
import { foldDiff, lineDiff, toolActivity, toolResults } from './chat-model';
import { aiStatusQuery } from './session';
import { Working } from './working';

/**
 * The page chat (wikistow.md, AI assistant): a conversation with one of
 * this person's chat assistants, beside the page. It says which provider,
 * assistant and folders are in use; the page on screen goes with a message
 * only when the person includes it; and the assistant's proposals wait
 * here for the person to approve or reject each.
 */
export function ChatPanel({ onClose }: { onClose: () => void }) {
  const { data: status, error } = useQuery(aiStatusQuery);
  const { chat } = useChatStore();
  return (
    <aside
      aria-label="Assistant"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-card bg-card shadow-card"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-primary" strokeWidth={1.75} />
        <h2 className="flex-1 font-extrabold">Assistant</h2>
        <button
          type="button"
          aria-label="Close the assistant"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-control hover:bg-accent"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </header>
      {error ? (
        <p className="p-4 text-sm text-destructive">Couldn’t check whether AI is set up.</p>
      ) : !status ? null : !status.enabled ? (
        <p className="p-4 text-sm text-muted-foreground">
          AI isn’t set up on this server, so there’s no assistant. The person who runs the server
          can connect an AI provider.
        </p>
      ) : chat instanceof WorkshopChat ? (
        <WorkshopConversation key={chat.workshop.id} chat={chat} provider={status} />
      ) : chat ? (
        <Conversation key={chat.state().agent.agentId} chat={chat} provider={status} />
      ) : (
        <ChooseAgent host={status.host} />
      )}
    </aside>
  );
}

/** Pick which assistant to talk to, or add one. */
function ChooseAgent({ host }: { host: string }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { safeMode } = usePlugins();
  const agents = listAppAgents(ctx.contacts.book.payloads);
  const [agentId, setAgentId] = useState<IdentityId | null>(agents[0]?.agentId ?? null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<IdentityId | null>(null);
  const start = (id: IdentityId) => {
    const agent = listAppAgents(ctx.contacts.book.payloads).find((a) => a.agentId === id);
    if (!agent) return;
    chatStore.start(
      new AgentChat(ctx, agent, {
        onChanged: ({ spaceId, pageId }) => {
          void queryClient.invalidateQueries({ queryKey: [PLAIN, 'tree', spaceId] });
          if (pageId) void queryClient.invalidateQueries({ queryKey: [PLAIN, 'page', pageId] });
          searchIndexChanged(queryClient);
        },
      }),
    );
  };
  return (
    <div className="grid content-start gap-4 overflow-y-auto p-4">
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          An assistant finds, reads and drafts pages for you, in the folders you give it. It has its
          own keys, never does more than you can, and changes nothing until you approve it.
        </p>
      ) : (
        <div className="grid gap-2">
          <Picker
            label="Assistant"
            value={agentId}
            options={agents.map((a) => ({ value: a.agentId, label: a.name, icon: Bot }))}
            onChange={setAgentId}
          />
          <Button disabled={!agentId} onClick={() => agentId && start(agentId)}>
            Start a conversation
          </Button>
        </div>
      )}
      <Button
        variant={agents.length === 0 ? 'default' : 'secondary'}
        onClick={() => setAdding(true)}
      >
        <Plus strokeWidth={1.75} /> Add an assistant
      </Button>
      {desktop && !safeMode && (
        <Button variant="outline" onClick={() => void navigate({ to: '/workshop' })}>
          <Puzzle strokeWidth={1.75} /> Build a plugin
        </Button>
      )}
      <AiDisclosure host={host} />
      <AddAgentDialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          // Once the person has read how it went, talk to the new one.
          if (!open && added) start(added);
        }}
        inApp
        onAdded={setAdded}
      />
    </div>
  );
}

type Provider = { host: string; model: string };

function Conversation({ chat, provider }: { chat: AgentChat; provider: Provider }) {
  const state = useSyncExternalStore(chat.subscribe, chat.state);
  const session = chat.session();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <About state={state} provider={provider} />
      {state.phase === 'opening' && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Opening {state.agent.name}…
        </p>
      )}
      {state.failure && (
        <p role="alert" className="mx-4 mt-3 text-sm text-destructive">
          {state.phase === 'failed'
            ? `Couldn’t open this assistant: ${state.failure}`
            : state.failure}
        </p>
      )}
      {session && <Messages session={session} chat={chat} state={state} host={provider.host} />}
    </div>
  );
}

/** Which provider, assistant and folders this chat uses, and the pages it changed. */
function About({ state, provider }: { state: ChatState; provider: Provider }) {
  return (
    <div className="grid gap-1.5 border-b px-4 py-2.5 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <Bot className="mr-1 inline size-3.5" strokeWidth={1.75} />
          <strong className="text-foreground">
            <Name>{state.agent.name}</Name>
          </strong>
        </span>
        <span>
          {provider.model} at {provider.host}
        </span>
        <button
          type="button"
          onClick={() => chatStore.end()}
          className="ml-auto font-bold text-primary hover:underline"
        >
          New conversation
        </button>
      </div>
      {state.scope.length > 0 && (
        <p>
          Works in{' '}
          {state.scope.map((place, index) => (
            <span key={`${place.spaceId}:${index}`}>
              {index > 0 && ', '}
              <Name>{place.name ?? 'an unnamed folder'}</Name> ({place.access})
            </span>
          ))}
          {!state.canEdit && '. It can only read published pages.'}
        </p>
      )}
      {state.changed.length > 0 && (
        <p>
          Changed:{' '}
          {state.changed.map((changed, index) => (
            <span key={index}>
              {index > 0 && ', '}
              {changed.pageId ? (
                <PageLink page={{ ...changed, pageId: changed.pageId, title: changed.label }} />
              ) : (
                <Name>{changed.label}</Name>
              )}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function PageLink({ page }: { page: PageRef }) {
  return (
    <Link
      to="/s/$spaceId/p/$pageId"
      params={{ spaceId: page.spaceId, pageId: page.pageId }}
      search={{ view: 'draft' }}
      className="font-bold text-primary hover:underline"
    >
      <Name>{page.title}</Name>
    </Link>
  );
}

function Messages({
  session,
  chat,
  state,
  host,
}: {
  session: AiSession;
  chat: AgentChat;
  state: ChatState;
  host: string;
}) {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const ai = useSyncExternalStore(subscribe, session.state);
  const end = useRef<HTMLDivElement>(null);
  const shown = ai.messages.length + state.proposals.length;
  // Braces: Chromium's scrollIntoView now answers a promise, which isn't a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown, ai.messages]);
  const results = toolResults(ai.messages);
  let turn = 0;
  return (
    <>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-4 py-3">
        {ai.messages.length === 0 && <AiDisclosure host={host} />}
        {ai.messages.map((message, index) => {
          if (message.role === 'user') {
            const sent = state.turns[turn++];
            return <UserMessage key={index} text={sent?.text ?? message.text} turn={sent} />;
          }
          if (message.role === 'assistant')
            return (
              <AssistantMessage
                key={index}
                message={message}
                results={results}
                chat={chat}
                proposals={state.proposals}
                applying={state.applying}
              />
            );
          return null;
        })}
        <ApproveAll chat={chat} proposals={state.proposals} busy={state.applying} />
        {state.seen.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Pages it looked at:{' '}
            {state.seen.map((page, index) => (
              <span key={page.pageId}>
                {index > 0 && ', '}
                <PageLink page={page} />
              </span>
            ))}
          </p>
        )}
        {ai.finish === 'stopped' && (
          <p role="status" className="text-xs text-muted-foreground">
            Stopped.{' '}
            {state.changed.length > 0
              ? 'Changes you approved before stopping stay made.'
              : 'Nothing was changed.'}
          </p>
        )}
        {ai.failure && (
          <p role="alert" className="text-sm text-destructive">
            {ai.failure.message}
          </p>
        )}
        <div ref={end} />
      </div>
      <Composer
        chat={chat}
        running={ai.status === 'running' || state.applying}
        disabled={state.phase !== 'ready'}
      />
    </>
  );
}

function UserMessage({
  text,
  turn,
}: {
  text: string;
  turn: ChatState['turns'][number] | undefined;
}) {
  return (
    <div className="grid justify-items-end gap-1">
      {turn?.context && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <FileText className="size-3" strokeWidth={1.75} />
          <span>
            Included “<Name>{turn.context.title}</Name>”
          </span>
        </span>
      )}
      <p className="max-w-[90%] rounded-card bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        {text}
      </p>
    </div>
  );
}

/** The assistant's words, as plain text, and what its tools did. */
function AssistantMessage({
  message,
  results,
  chat,
  proposals,
  applying,
}: {
  message: Extract<AiMessage, { role: 'assistant' }>;
  results: ReturnType<typeof toolResults>;
  chat: AgentChat;
  proposals: readonly ProposalItem[];
  /** Approved proposals are being made: one batch at a time. */
  applying: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      {message.text.trim() && <p className="text-sm whitespace-pre-wrap">{message.text}</p>}
      {message.toolCalls.map((call) => {
        const result = results.get(call.id);
        return (
          <div key={call.id} className="grid gap-1.5">
            <p className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden>{result ? (result.isError ? '✕' : '✓') : '…'}</span>
              <span className={cn(result?.isError && 'text-destructive')}>
                {toolActivity(call.name, call.input)}
                {result?.isError && `: ${result.output}`}
              </span>
            </p>
            {proposals
              .filter((item) => item.callId === call.id)
              .map((item) => (
                <ProposalCard key={item.proposal.id} item={item} chat={chat} busy={applying} />
              ))}
          </div>
        );
      })}
    </div>
  );
}

const STATE_LABELS: Record<ProposalItem['state'], string> = {
  pending: 'Waiting for you',
  applying: 'Applying…',
  done: 'Applied',
  rejected: 'Rejected',
  dropped: 'Dropped',
  stale: 'Not applied',
  refused: 'Not applied',
  failed: 'Not applied',
  revoked: 'Dropped',
};

/** With more than one proposal waiting, approve them all at once. */
function ApproveAll({
  chat,
  proposals,
  busy,
}: {
  chat: AgentChat;
  proposals: readonly ProposalItem[];
  busy: boolean;
}) {
  const pending = proposals.filter((item) => item.state === 'pending');
  if (pending.length < 2) return null;
  return (
    <div className="grid gap-1 rounded-card bg-muted p-3">
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void chat.approve(
            pending.map((item) => item.proposal.id),
            saveOpenDraft,
          )
        }
      >
        Approve all {pending.length}
      </Button>
      <p className="text-xs text-muted-foreground">
        Each change is made on its own, in order. If one can’t be made, the others still are.
      </p>
    </div>
  );
}

/** One proposal, to approve or reject on its own. */
function ProposalCard({
  item,
  chat,
  busy,
}: {
  item: ProposalItem;
  chat: AgentChat;
  busy: boolean;
}) {
  const { proposal, state, message } = item;
  return (
    <article
      aria-label={`Proposal ${proposal.id}`}
      className="grid gap-2 rounded-card border p-3 text-sm"
    >
      <header className="flex items-start gap-2">
        <span className="min-w-0 flex-1 font-bold">
          {proposal.id}. <Name>{labelOf(proposal)}</Name>
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-bold',
            state === 'done'
              ? 'bg-status-published text-status-published-foreground'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {STATE_LABELS[state]}
        </span>
      </header>
      {proposal.summary && (
        <p className="text-xs text-muted-foreground">
          <Name>{proposal.summary}</Name>
        </p>
      )}
      <ProposalDetail proposal={proposal} />
      {message && (
        <p role="alert" className="text-xs text-destructive">
          {message}
        </p>
      )}
      {state === 'pending' && (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void chat.approve([proposal.id], saveOpenDraft)}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => chat.reject(proposal.id)}
          >
            Reject
          </Button>
        </div>
      )}
    </article>
  );
}

/** Exactly what approving it does: where, and the text, or the change to it. */
function ProposalDetail({ proposal }: { proposal: ProposalItem['proposal'] }) {
  switch (proposal.kind) {
    case 'create-page':
      return (
        <>
          <p className="text-xs">
            A new draft in <Name>{proposal.where}</Name>.
          </p>
          <Text>{proposal.markdown}</Text>
        </>
      );
    case 'create-folder':
      return (
        <p className="text-xs">
          A new folder in <Name>{proposal.where}</Name>.
        </p>
      );
    case 'move':
      return (
        <p className="text-xs">
          From <Name>{proposal.from}</Name> to <Name>{proposal.where}</Name>, with everything in it.
        </p>
      );
    case 'edit-page':
      return <EditDetail before={proposal.before.markdown} after={proposal.markdown} />;
  }
}

/** An edit's change to the draft, as a line diff, worked out once per proposal. */
function EditDetail({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => {
    const lines = before === after ? null : lineDiff(before, after);
    return lines && foldDiff(lines);
  }, [before, after]);
  return (
    <>
      <p className="text-xs">A new draft of this page, on top of the draft it read.</p>
      {before === after ? null : diff ? (
        <pre
          aria-label="Changes"
          className="max-h-64 overflow-auto rounded-control bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
        >
          {diff.map((line, index) =>
            line.kind === 'fold' ? (
              <div key={index} className="text-muted-foreground">
                ⋯ {line.count} unchanged
              </div>
            ) : (
              <div
                key={index}
                className={cn(
                  line.kind === 'added' && 'bg-status-published/30',
                  line.kind === 'removed' && 'bg-destructive/15 line-through',
                )}
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
                {line.text}
              </div>
            ),
          )}
        </pre>
      ) : (
        <Text>{after}</Text>
      )}
    </>
  );
}

function Text({ children }: { children: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-control bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
      {children}
    </pre>
  );
}

/**
 * The message box, with the page on screen offered to include. It goes
 * only with the next message, and only if the person includes it;
 * moving to another page offers that page instead.
 */
function Composer({
  chat,
  running,
  disabled,
}: {
  chat: AgentChat;
  running: boolean;
  disabled: boolean;
}) {
  const { page } = useChatStore();
  const [text, setText] = useState('');
  const [included, setIncluded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // From Send until chat.send settles: it reads the included page, then waits out the reply.
  const [sending, setSending] = useState(false);
  // From Send until the reply starts. After Stop, a tool call still settling isn't shown as work.
  const [starting, setStarting] = useState(false);
  if (starting && running) setStarting(false);
  const busy = running || sending;
  const including = page !== null && included === page.pageId;
  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setError(null);
    setSending(true);
    setStarting(true);
    try {
      const sent = chat.send(message, including ? page : null);
      setText('');
      setIncluded(null);
      await sent;
    } catch (caught) {
      setText(message);
      setError(caught instanceof Error ? caught.message : 'Couldn’t send that.');
    } finally {
      setSending(false);
      setStarting(false);
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
          aria-pressed={including}
          onClick={() => setIncluded(including ? null : page.pageId)}
          className={cn(
            'flex w-fit max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
            including
              ? 'border-primary bg-primary/10 font-bold text-primary'
              : 'text-muted-foreground hover:bg-accent',
          )}
        >
          <FileText className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">
            {including ? 'Including' : 'Include'} “<Name>{page.title}</Name>”
          </span>
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Working working={running || starting} />
      <div className="flex items-end gap-2">
        {/* 16px on phones: iOS zooms in on a smaller field when it's focused. */}
        <textarea
          aria-label="Message"
          value={text}
          rows={2}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask about your pages, or ask for a change"
          className="max-h-40 min-h-10 flex-1 resize-none rounded-control border border-input bg-background px-3 py-2 text-base outline-ring focus-visible:outline-2 md:text-sm"
        />
        {running ? (
          <Button type="button" variant="secondary" onClick={() => chat.stop()}>
            <Square strokeWidth={1.75} /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={disabled || sending || !text.trim()}>
            Send
          </Button>
        )}
      </div>
    </form>
  );
}
