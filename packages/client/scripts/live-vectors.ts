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
  newPayload,
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
  firstSnapshot,
  presenceContent,
  sealLiveMessage,
  stateContent,
  startLiveSession,
  type LiveBinding,
} from '../src/live/index.ts';
import { sodium } from '../src/sodium.ts';
import {
  state as handState,
  update as handWritten,
  type Struct,
} from '../test/support/yjs-bytes.ts';

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
  // A Saved notice naming the document's state, as `Y.encodeSnapshot` writes it.
  const state = Y.encodeSnapshot(Y.snapshot(doc));
  const saved = sealLiveMessage({
    sender: starter,
    binding,
    kind: 'saved',
    joinId: started.joinId,
    seq: 3,
    clock: 1,
    content: stateContent(RevisionId.parse('vector-live-draft-2'), state),
  });
  // Padding at the edge of a bucket, and a clock past 2^32.
  const filler = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);
  const padding = [
    { kind: 'update' as const, clock: 2 ** 40 + 5, content: filler(119) },
    { kind: 'update' as const, clock: 0, content: filler(120) },
    { kind: 'presence' as const, clock: 7, content: filler(503) },
  ].map(({ kind, clock, content: bytes }) => ({
    kind,
    clock,
    content: hex(bytes),
    padded: hex(pad(kind, clock, bytes)),
  }));
  // Updates a receiver's decoder must accept, and must refuse.
  const bom = new Y.Doc();
  bom.clientID = 7;
  bom.getText('body').insert(0, '\uFEFFx');
  const twice = new Y.Doc();
  twice.clientID = 7;
  const sets: Uint8Array[] = [];
  twice.on('update', (u: Uint8Array) => sets.push(u));
  twice.getMap('extensions').set('a', '"x"');
  twice.getMap('extensions').set('a', '"y"');
  const text = { content: { string: 'x' } } as const;
  const one = (struct: Struct) =>
    handWritten({ sections: [{ client: 7, clock: 0, structs: [struct] }] });
  const decoder = {
    accept: {
      emptyUpdate: hex(new Uint8Array([0, 0])),
      leadingBom: hex(Y.encodeStateAsUpdate(bom)),
      secondMapSet: hex(Y.mergeUpdates(sets)),
    },
    refuse: {
      trailingByte: hex(new Uint8Array([0, 0, 0])),
      nonMinimalClient: hex(
        new Uint8Array([1, 1, 0x87, 0, 0, 4, 1, 4, 98, 111, 100, 121, 1, 0x78, 0]),
      ),
      gcStruct: hex(handWritten({ sections: [{ client: 7, clock: 0, structs: [{ gc: 3 }] }] })),
      skipStruct: hex(handWritten({ sections: [{ client: 7, clock: 0, structs: [{ skip: 3 }] }] })),
      parentById: hex(
        handWritten({
          sections: [
            {
              client: 7,
              clock: 0,
              structs: [{ ...text, parent: { id: { client: 1, clock: 0 } } }],
            },
          ],
        }),
      ),
      unknownRoot: hex(
        handWritten({
          sections: [{ client: 7, clock: 0, structs: [{ ...text, parent: 'comments' }] }],
        }),
      ),
      numberValue: hex(
        handWritten({
          sections: [
            {
              client: 7,
              clock: 0,
              structs: [{ parent: 'fields', parentSub: 'n', content: { any: [1] } }],
            },
          ],
        }),
      ),
      emptyDeleteRange: hex(handWritten({ deletes: [{ client: 7, ranges: [[0, 0]] }] })),
      clientTwiceInStructs: hex(
        handWritten({
          sections: [
            { client: 7, clock: 0, structs: [text] },
            { client: 7, clock: 1, structs: [text] },
          ],
        }),
      ),
      clientTwiceInDeletes: hex(
        handWritten({
          deletes: [
            { client: 7, ranges: [[0, 1]] },
            { client: 7, ranges: [[2, 1]] },
          ],
        }),
      ),
      sectionWithoutStructs: hex(handWritten({ sections: [{ client: 7, clock: 0, structs: [] }] })),
      clientWithoutRanges: hex(handWritten({ deletes: [{ client: 7, ranges: [] }] })),
      emptyString: hex(one({ content: { string: '' } })),
      emptyValueList: hex(one({ parent: 'fields', parentSub: 'n', content: { any: [] } })),
      ownOriginAhead: hex(one({ origin: { client: 7, clock: 0 }, content: { string: 'x' } })),
      notUtf8: hex(one({ content: { raw: 4, bytes: [2, 0xc3, 0x28] } })),
      contentEmbed: hex(one({ content: { raw: 5, bytes: [2, 0x7b, 0x7d] } })),
      contentFormat: hex(one({ content: { raw: 6, bytes: [1, 0x62, 4, 0x74, 0x72, 0x75, 0x65] } })),
      contentType: hex(one({ content: { raw: 7, bytes: [1] } })),
    },
  };
  // States a receiver's decoder must refuse: each counts as none.
  const states = {
    accept: { saved: hex(Y.encodeSnapshot(Y.snapshot(doc))) },
    refuse: {
      zeroClock: hex(handState({ vector: [[7, 0]] })),
      clientTwice: hex(
        handState({
          vector: [
            [7, 1],
            [7, 2],
          ],
        }),
      ),
      clientWithoutRanges: hex(handState({ deletes: [{ client: 7, ranges: [] }] })),
      emptyRange: hex(handState({ deletes: [{ client: 7, ranges: [[0, 0]] }] })),
      trailingByte: hex(new Uint8Array([...handState({ vector: [[7, 1]] }), 0])),
    },
  };
  // The first snapshot, as the starter sends it with the record.
  const first = firstSnapshot({
    sender: starter,
    binding,
    joinId: started.joinId,
    clientId,
    revisionId: RevisionId.parse('vector-live-draft'),
    payload: newPayload({ title: 'Lasagne', markdown: 'Brown the mince.' }),
  });
  const snapshotHeader = { ...header, kind: 'snapshot' as const, seq: 1 };
  const snapshot = {
    message: first.message,
    ad: hex(liveMessageAd(binding, snapshotHeader)),
    signedBytes: hex(
      liveMessageBytes(binding, snapshotHeader, hash(sealedBytes(first.message.sealed))),
    ),
    padded: hex(
      aeadDecrypt({
        key: sessionKey,
        sealed: first.message.sealed,
        ad: liveMessageAd(binding, snapshotHeader),
      }),
    ),
    state: hex(Y.encodeStateAsUpdate(first.document.doc)),
  };
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
    saved: { message: saved, state: hex(state), revisionId: 'vector-live-draft-2' },
    padding,
    decoder,
    states,
    snapshot,
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
