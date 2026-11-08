// The library plugins a person approved (ADR 0002), kept in the private part
// of their contacts record so they follow the person to every device. Each
// operation is one contacts write (`saveContacts`): after a lost race it is
// re-applied on top of the newer record, so two devices' changes to
// different plugins both stand, and for one plugin the last write does.
import type { PluginScope } from '@wikistow/contracts';
import type { Settings } from '@wikistow/plugin-sdk';
import { SettingsValue } from '@wikistow/plugin-sdk/manifest';
import type { ContactsChange } from '../contacts.ts';
import { PluginApproval, pluginApprovals } from '../plugin-approvals.ts';
import { saveContacts, type ClientContext } from './session.ts';

/**
 * The approved library plugins, as this session last read or wrote the
 * record. The session reads it at unlock (`openSession`), so an approval
 * made on another device applies from the next unlock.
 */
export const listPluginApprovals = (ctx: ClientContext): PluginApproval[] =>
  pluginApprovals(ctx.contacts.book.payloads.private);

const Access = PluginApproval.shape.access;

async function save(ctx: ClientContext, change: ContactsChange): Promise<PluginApproval[]> {
  await saveContacts(ctx, [change]);
  return listPluginApprovals(ctx);
}

/**
 * Install a library plugin: approve its version `hash` with plugin access
 * `access`, turned on. Approving one already there replaces its entry.
 * Returns the approvals once written.
 */
export const approvePlugin = async (
  ctx: ClientContext,
  approval: { id: string; hash: string; access: readonly PluginScope[] },
) =>
  save(ctx, {
    kind: 'plugin-approve',
    approval: PluginApproval.parse({ ...approval, enabled: true }),
  });

/** Approve a newer version of an installed plugin: its `hash` replaces the old one. */
export const updatePlugin = async (ctx: ClientContext, pluginId: string, hash: string) =>
  save(ctx, {
    kind: 'plugin-change',
    pluginId,
    set: { hash: PluginApproval.shape.hash.parse(hash) },
  });

/** Replace an installed plugin's plugin access. */
export const setPluginAccess = async (
  ctx: ClientContext,
  pluginId: string,
  access: readonly PluginScope[],
) => save(ctx, { kind: 'plugin-change', pluginId, set: { access: Access.parse(access) } });

/** Turn an installed plugin on or off, on every device. */
export const setPluginEnabled = async (ctx: ClientContext, pluginId: string, enabled: boolean) =>
  save(ctx, { kind: 'plugin-change', pluginId, set: { enabled } });

/** Set the regions where an installed plugin gives way to the app's own part, on every device. */
export const setPluginOwnParts = async (
  ctx: ClientContext,
  pluginId: string,
  regions: readonly string[],
) => save(ctx, { kind: 'plugin-change', pluginId, set: { ownParts: [...regions] } });

/** Replace an installed plugin's settings, on every device. */
export const setPluginSettings = async (ctx: ClientContext, pluginId: string, settings: Settings) =>
  save(ctx, {
    kind: 'plugin-change',
    pluginId,
    set: { settings: SettingsValue.parse(settings) },
  });

/** Remove a plugin's approval and its settings, on every device. Pages keep its blocks and data. */
export const removePlugin = async (ctx: ClientContext, pluginId: string) =>
  save(ctx, { kind: 'plugin-remove', pluginId });
