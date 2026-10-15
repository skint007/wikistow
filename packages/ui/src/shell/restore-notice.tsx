import { useQuery } from '@tanstack/react-query';
import { restoreNotice, unseenRestore, type Restore } from '@wikistow/client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { installationQuery } from '../api';

// The `restoredAt` of the last restore this device has seen of an
// installation, or '' for none. In `localStorage`, like the theme: it's
// about the device, not the account.
const seenKey = (installationId: string) => `wikistow.restore.${installationId}`;

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Says the server was restored from a backup, to a device that used it
 * before, until dismissed: once per restore. A dialog, so it covers none of
 * the notices kept in the bottom corner. A device meeting the server for
 * the first time keeps its last restore and says nothing.
 */
export function RestoreNotice() {
  const { data: installation } = useQuery(installationQuery);
  const [unseen, setUnseen] = useState<Restore | null>(null);
  useEffect(() => {
    if (!installation) return;
    const key = seenKey(installation.installationId);
    const seen = localStorage.getItem(key);
    if (seen === null) localStorage.setItem(key, installation.restore?.restoredAt ?? '');
    else setUnseen(unseenRestore(installation.restore, seen || null));
  }, [installation]);

  const dismiss = () => {
    if (installation && unseen) {
      localStorage.setItem(seenKey(installation.installationId), unseen.restoredAt);
    }
    setUnseen(null);
  };
  return (
    <Dialog open={unseen !== null} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Restored from a backup</DialogTitle>
          <DialogDescription>{unseen && restoreNotice(unseen, dateTime)}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={dismiss}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
