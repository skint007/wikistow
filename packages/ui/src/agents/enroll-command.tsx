import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { installationQuery } from '../api';

/**
 * What starts an enrollment against this server, as the CLI wants it
 * (`--server` is required). The server names its own origin: the desktop
 * app's pages live at `app://`, which the CLI can't reach.
 */
export const enrollCommand = (origin: string) => `wikistow agent enroll --server ${origin}`;

/**
 * Where an agent's lookup code comes from: the exact command to run in a
 * terminal on the agent's computer, with a button that copies it.
 */
export function EnrollCommand() {
  const { data } = useQuery(installationQuery);
  const command = enrollCommand(data?.origin ?? location.origin);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-control bg-muted py-1.5 pr-1.5 pl-3">
      <code data-testid="enroll-command" className="min-w-0 flex-1 font-mono text-sm break-words">
        {command}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? <Check strokeWidth={1.75} /> : <Copy strokeWidth={1.75} />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
