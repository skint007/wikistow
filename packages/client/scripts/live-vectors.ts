// The live-session part of the cross-platform vectors (protocol section
// 5.10, see generate-vectors.ts): a session record wrapped under a share's
// draft key, and the three domains it adds, `live-client/v1`,
// `live-message-payload/v1` and `live-message/v1`, with the keys in the
// clear so another implementation can check each layer on its own.
import * as Y from 'yjs';
import {
  aeadDecrypt,
  canonical,
  fromBase64,
  generateIdentity,
  hash,
  IdentityId,
  InstallationId,
  metadataAd,
  metadataRecordV2Bytes,
  newFolderKeys,
  PageId,
  RevisionId,
  ShareId,
  sealedBytes,
  SpaceId,
  toBase64,
  wrapAd,
  type PrivateIdentity,
} from '../src/index.ts';
import {
  liveClientId,
  liveMessageAd,
  liveMessageBytes,
  liveWrapSubject,
  pad,
  presenceContent,
  sealLiveMessage,
  startLiveSession,
  type LiveBinding,
} from '../src/live/index.ts';
import { sodium } from '../src/sodium.ts';

const exportIdentity = (identity: PrivateIdentity) => ({
  public: identity.public,
  boxSecretKey: toBase64(identity.boxSecretKey),
  signSecretKey: toBase64(identity.signSecretKey),
});

const hex = (bytes: Uint8Array) => sodium.to_hex(bytes);

/** The section's identity from the current file, kept so a regeneration moves only what changed. */
export type LivePrevious = { starter: PrivateIdentity };

export function liveVectors(previous?: LivePrevious) {
  const installationId = InstallationId.parse('vector-installation');
  const spaceId = SpaceId.parse('vector-space');
  const pageId = PageId.parse('vector-live-page');
  const shareId = ShareId.parse('vector-live-share');
  const starter =
    previous?.starter ??
    generateIdentity({ id: IdentityId.parse('vector-live-starter'), kind: 'human' });
  const folderKeys = newFolderKeys();

  const started = startLiveSession({
    author: starter,
    installationId,
    spaceId,
    pageId,
    revisionId: RevisionId.parse('vector-live-draft'),
    share: { shareId, keyVersion: 1, draftKey: folderKeys.draftKey },
  });
  const { record } = started.sealed;
  const subject = liveWrapSubject({
    spaceId,
    sessionId: record.subjectId,
    versionId: record.metadataRevisionId,
  });
  const recordBytes = metadataRecordV2Bytes(record);
  const recordHash = hash(recordBytes);
  // The session key, as anyone holding the draft key opens it.
  if (!started.wrap) throw new Error('A session in a share has a wrap');
  const contentKey = aeadDecrypt({
    key: folderKeys.draftKey,
    sealed: started.wrap.wrappedKey,
    ad: wrapAd(installationId, subject, { shareId, keyVersion: 1 }),
  });
  const payload = JSON.parse(
    new TextDecoder().decode(
      aeadDecrypt({ key: contentKey, sealed: started.sealed.payload, ad: metadataAd(record) }),
    ),
  ) as { key: string };
  const sessionKey = fromBase64(payload.key);
  const binding: LiveBinding = {
    installationId,
    spaceId,
    pageId,
    sessionId: record.subjectId,
    recordHash,
    key: sessionKey,
  };

  // One character typed by the starter's join, as Yjs writes it.
  const clientId = liveClientId({
    installationId,
    sessionId: record.subjectId,
    senderId: starter.public.id,
    senderKeyVersion: starter.public.keyVersion,
    joinId: started.joinId,
  });
  const doc = new Y.Doc();
  doc.clientID = clientId;
  doc.getText('body').insert(0, 'ü');
  const content = Y.encodeStateAsUpdate(doc);
  const header = {
    kind: 'update' as const,
    senderId: starter.public.id,
    senderKeyVersion: starter.public.keyVersion,
    joinId: started.joinId,
    seq: 2,
  };
  const update = sealLiveMessage({
    sender: starter,
    binding,
    kind: 'update',
    joinId: started.joinId,
    seq: 2,
    clock: 1,
    content,
  });
  const presence = sealLiveMessage({
    sender: starter,
    binding,
    kind: 'presence',
    joinId: started.joinId,
    seq: 2,
    clock: 1,
    content: presenceContent({
      format: { major: 1, minor: 0 },
      editor: 'source',
      visible: true,
      publishing: false,
      saveFailing: null,
      cursor: null,
    }),
  });
  const clientInput = canonical('live-client/v1', [
    installationId,
    record.subjectId,
    starter.public.id,
    starter.public.keyVersion,
    started.joinId,
  ]);

  return {
    starter: exportIdentity(starter),
    folderKeys: {
      shareId,
      keyVersion: 1,
      draftKey: toBase64(folderKeys.draftKey),
      publishedKey: toBase64(folderKeys.publishedKey),
    },
    session: {
      sealed: started.sealed,
      wrap: started.wrap,
      subject,
      wrapAd: hex(
        canonical('content-key-wrap/v1', [
          installationId,
          spaceId,
          shareId,
          1,
          subject.audienceClass,
          subject.subjectKind,
          subject.subjectId,
          subject.versionId,
        ]),
      ),
      payloadAd: hex(metadataAd(record)),
      signedBytes: hex(recordBytes),
      recordHash,
      payload,
    },
    client: {
      sessionId: record.subjectId,
      senderId: starter.public.id,
      senderKeyVersion: starter.public.keyVersion,
      joinId: started.joinId,
      input: hex(clientInput),
      digest: hex(sodium.crypto_generichash(8, clientInput, null)),
      clientId,
    },
    update: {
      header,
      clock: 1,
      content: hex(content),
      padded: hex(pad('update', 1, content)),
      ad: hex(liveMessageAd(binding, header)),
      payloadHash: hash(sealedBytes(update.sealed)),
      signedBytes: hex(liveMessageBytes(binding, header, hash(sealedBytes(update.sealed)))),
      message: update,
    },
    presence: {
      message: presence,
      padded: hex(
        aeadDecrypt({
          key: sessionKey,
          sealed: presence.sealed,
          ad: liveMessageAd(binding, { ...header, kind: 'presence' }),
        }),
      ),
    },
  };
}
