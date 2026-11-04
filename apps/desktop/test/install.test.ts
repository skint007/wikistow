import { describe, expect, it } from 'vite-plus/test';
import { desktopApp, packagedFolder } from '../src/install.ts';

describe('desktopApp', () => {
  it('is the beta only when it runs from the beta package’s folder on Linux', () => {
    expect(desktopApp('/usr/lib/wikistow-desktop-beta/app.asar', 'linux')).toBe('beta');
    expect(desktopApp('/usr/lib/wikistow-desktop/app.asar', 'linux')).toBe('stable');
    expect(desktopApp('/usr/lib/wikistow-desktop/resources/app.asar', 'linux')).toBe('stable');
    expect(desktopApp('/home/me/wikistow/apps/desktop', 'linux')).toBe('stable');
    expect(desktopApp('/usr/lib/wikistow-desktop-beta/app.asar', 'win32')).toBe('stable');
  });
});

describe('packagedFolder', () => {
  it('names the package folder the app runs from, the .deb’s resources included', () => {
    expect(packagedFolder('/usr/lib/wikistow-desktop/app.asar', 'linux')).toBe(
      '/usr/lib/wikistow-desktop',
    );
    expect(packagedFolder('/usr/lib/wikistow-desktop/resources/app.asar', 'linux')).toBe(
      '/usr/lib/wikistow-desktop',
    );
    expect(packagedFolder('/usr/lib/wikistow-desktop-beta/app.asar', 'linux')).toBe(
      '/usr/lib/wikistow-desktop-beta',
    );
    expect(packagedFolder('/usr/lib/wikistow-desktop-other/app.asar', 'linux')).toBeNull();
    expect(packagedFolder('/opt/WikiStow/resources/app.asar', 'linux')).toBeNull();
  });
});
