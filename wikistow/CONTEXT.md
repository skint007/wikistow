# WikiStow

A wiki for family and friends to keep personal knowledge and share selected documents. People and their existing agents work on the same pages under explicit permissions.

## People and access

**Account**
A person's identity in the installation. Account access is separate from access to that person's encrypted documents.

**Administrator**
A member who manages registration, invitations, accounts, and service settings. This role does not grant access to private content. Suspending an account blocks its access to the server, but doesn't remove it from shares; an owner does that.

**Agent identity**
A named identity belonging to one account, with its own credentials, attribution, and limited content permissions. An agent never receives more authority than its owner currently has. Its person gives it a name while approving it, picks the folders it may use, and is the only one who seals folder keys to it. Its edits are shown as the agent's, for its person.

**Agent credential**
The bearer token an enrolled agent uses to reach the server. It authenticates the agent; the agent's own keys decrypt content. Revoking the agent, resetting the owner's password, or an administrator's revoke ends it for good. It doesn't take back folder keys the agent already holds; an owner rotates the keys for that.

**Chat assistant**
An agent identity the person's own app runs for the page chat, rather than a CLI. The app enrolls it itself and keeps its keys in the person's encrypted contacts record. It reads with its own grants, and changes nothing until the person approves each of its proposals.

**Proposal**
A change a chat assistant worked out (a new page or folder, an edit or rename of a draft, a move) and showed the person instead of making. Approving makes exactly that change, as the assistant, if nothing it was based on changed meanwhile; otherwise the assistant has to propose again.

**AI provider**
The one AI service an installation's operator configures for the assistant. The server forwards conversations to it with its key, which no client sees. Content a person sends to the assistant leaves end-to-end encryption; tools the model asks for run in the person's app.

**Contact**
A person whose key your app has pinned. The contact keeps the name and email it had when first seen, which you may rename, and the app always shows the contact by those, never by names the server supplies later. Your contacts are kept in an encrypted record that only you and your agents can read; their names and emails are readable by you alone.

**Group**
A named set of people, and their agents, within one space, that a folder or the space is shared with as one. Only the space's owners manage it and read its name. It holds no keys: each member gets the folder keys sealed to them. Built in Milestone 5 for people; agents in groups are not built yet.
_Avoid_: Team, role.

**Effective access**
A person's access in a share: the highest of their direct role there and the roles of their groups that have the share. Any one of these keeps them in.

**Waiting for keys**
A person a group brings into a share before an owner's app has sealed its keys to them, as after a key change. They have no access there until an owner gives it.

**Grant**
Permission for a person or agent to access a space or a folder, never a single page. It applies to the folder's current and future descendants. A person's grant is their membership of a share, directly or through a group; an agent's grant is a folder its person picked for it, or a group it follows.

**Reader**
A person or agent allowed to read published versions of a page.

**Editor**
A person or agent allowed to read and change a page's draft as well as read its published versions.

**Publisher**
An editor with the additional authority to publish a page's draft.

**Space owner**
A person responsible for a space and its membership. Owners hold every key in the space, and are the only ones who share, remove people and rotate keys. A space always has at least one owner. Any owner can remove an owner, themself included, unless that would leave none; a transfer is the old owner adding the new one and then removing themself.

**Accepted owner**
An owner your app trusts for a space. Your app accepts itself in a space it created; otherwise it accepts whoever first gave it keys or named it as an owner there, asking you first when you were made an owner, and then anyone an accepted owner signed a statement for when adding a co-owner. Your app reads content from any owner it ever accepted, but uses keys only from those you haven't removed for anything else (writing, rotating, moving, publishing and passing keys to your agents), and seals only to accepted owners the server still lists. An owner you removed stays out until you add them again.
_Avoid_: Trusting an owner because the server lists them.

## Sharing and trust

**Share**
A space or folder that has its own folder keys and members. Shares don't nest: no share sits inside another. Content outside every share is readable by the space's owners only.
_Avoid_: Sharing a page; pages are shared only through their folder.

**Folder key**
A key that opens the content of one share. Each key version of a share has a **draft key** and a **published key**. Editors and owners hold both; readers hold only the published key, so they can never read drafts. Folder and space names use the published key.

**Key version**
One generation of a share's folder keys. Members receive every key version, so they can read the share's retained history. New content is always saved under the current key version, and the server refuses saves under an older one.

**Key rotation**
An owner making a new key version and sealing it only to the people who keep access. It happens when someone is removed, and when an owner chooses to, for example after an agent is revoked. The removed person keeps the older versions, so what they could already read stays readable to them.
_Avoid_: Rekey. Replacing a person's own identity keys is identity key rotation, a different thing.

**Pinned key**
The first public key your app saw for a person, kept in your contacts. If the server later shows a different key for them, your app warns you and stops sharing with them until you confirm the new key.
_Avoid_: Verified key, safety code.

**Shared with me**
The list of shares you are a member of. Each shows the shared folder's name and who shared it, never the names of the folders above it.

## Content

**Space**
A named collection of folders and pages with its own ownership and sharing rules. Personal and shared spaces are the same kind of collection.
_Avoid_: Public space when access requires membership.

**Folder**
A container within a space with one parent and any number of child folders or pages.

**Page**
A document with one location, an editable draft, and zero or more published versions. Its title and Markdown content belong to each version.

**Draft**
The current unpublished content of a page. Editors can see it; readers cannot.

**Published version**
An immutable version made available to a page's readers by a publisher. Later edits do not change it.

**Unpublish**
Withdrawing a page's published versions from its readers. The server hides them; no keys change. Readers who already read a version keep it.

**Publication**
A page in another space that receives explicitly published versions from a source page. It has its own audience and does not expose the source's drafts or history.

**Publication source**
The page and version a publication was copied from. It is recorded only inside the publication's encrypted content.

**Attachment**
A file referenced by a page version, such as an image or downloadable script. It has the same audience as the version that includes it, and its key travels inside that version.

**Wikilink**
A link written as `[[Page title]]` that resolves to a page in the same space by title. It follows the page when the page is renamed.

**Recovery key**
A secret a person saves outside the application to regain access to encrypted content if they lose their vault passphrase and authorized devices.

**Vault passphrase**
A secret used to unlock a person's encrypted keys. It is distinct from the account password and is not disclosed to the service.

## Plugins

**Plugin**
Code, styles or both that a person installs to change how WikiStow looks and works. In the desktop app it comes from a folder on that computer or from the server's **plugin library**; in the browser, from the library. Never from a page.
_Avoid_: Extension, add-on.

**Plugin library**
The plugins members uploaded to their server, which anyone signed in there may install. Installing is **approving** one version's hash; the approvals live in the person's own encrypted account data and follow them to every device.
_Avoid_: Store, marketplace (nothing is sold or rated).

**Theme plugin**, **script plugin**, **app plugin**
A plugin's trust level, from what it contains: styles only; code in an isolated worker that reaches pages only through checked requests; or code running in the app's page with the app's own trust.
_Avoid_: Sandboxed app plugin; app plugins aren't isolated.

**Plugin theme**
A theme a plugin adds to the theme picker: a stylesheet setting the app's tokens over a built-in palette, chosen on one device. The account's built-in choice is its **palette**.
_Avoid_: Skin, custom palette.

**Region**
A documented place in the app's interface that app plugins draw into (the rail, a plugin page, a page's toolbar, header, footer, aside and panel, a settings section), also named by a `data-region` attribute for styles.
_Avoid_: Slot, extension point (the internal registries).

**Plugin access**
The spaces and folders a person lets one plugin read or write for their account, within the person's own access.
_Avoid_: Grant, which is a share membership or an agent's folder.

**Plugin block**
A fenced code block in a page that names a plugin, which shows and edits it where that plugin is enabled. Elsewhere it is ordinary code. A script plugin's block is a form: **fields**, whose values are lines of the block's text, and **outputs**, which the script calculates from them and which are never stored.
_Avoid_: Page script; pages never carry code.

**Workshop**
Where a person builds a plugin with the assistant, in the desktop app: a workspace of the conversation's own, numbered **versions** built from it, and a **preview** that runs one version against **sample pages**, the workshop's own disposable pages. A real page enters only as a copy the person makes.
_Avoid_: Sandbox (the preview isn't one for app code), staging.

**Safe mode**
The desktop app, or one browser tab, running with no plugins loaded, to turn off one that broke the app.
