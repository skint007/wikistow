// Make Electron's Windows executable WikiStow's: its icon and the names
// Windows shows for it, in Task Manager and the file's properties. Run by
// scripts/windows-packages.sh on each architecture's copy:
//
//   node scripts/windows-exe.ts <WikiStow.exe> <version>
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';

const [exePath, version] = process.argv.slice(2);
if (!exePath || !version) throw new Error('Usage: windows-exe.ts <WikiStow.exe> <version>');
// Windows versions are four numbers; a prerelease keeps its release's.
const numbers = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!numbers) throw new Error(`${version} isn't a version`);
const [major = 0, minor = 0, patch = 0] = numbers.slice(1).map(Number);

const EN_US = 1033;
const exe = NtExecutable.from(await readFile(exePath));
const resources = NtExecutableResource.from(exe);

const icon = Data.IconFile.from(
  await readFile(fileURLToPath(new URL('../packaging/wikistow-desktop.ico', import.meta.url))),
);
const [group] = Resource.IconGroupEntry.fromEntries(resources.entries);
if (!group) throw new Error('The executable has no icon to replace');
Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  group.id,
  group.lang,
  icon.icons.map((item) => item.data),
);

const [info] = Resource.VersionInfo.fromEntries(resources.entries);
if (!info) throw new Error('The executable has no version information');
info.setFileVersion(major, minor, patch, 0, EN_US);
info.setProductVersion(major, minor, patch, 0, EN_US);
info.setStringValues(
  { lang: EN_US, codepage: 1200 },
  {
    FileDescription: 'WikiStow',
    ProductName: 'WikiStow',
    CompanyName: 'WikiStow',
    InternalName: 'WikiStow',
    OriginalFilename: 'WikiStow.exe',
    ProductVersion: version,
    FileVersion: version,
  },
);
info.outputToResourceEntries(resources.entries);

resources.outputResource(exe);
await writeFile(exePath, Buffer.from(exe.generate()));
