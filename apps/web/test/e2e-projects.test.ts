import { describe, expect, it } from 'vite-plus/test';
import { runsProject } from '../e2e/projects';

const cli = (...args: string[]) => ['node', 'playwright', 'test', ...args];

describe('runsProject', () => {
  it('runs every project when --project is not given', () => {
    expect(runsProject(cli(), 'live')).toBe(true);
    expect(runsProject(cli('e2e/pages.spec.ts', '--headed'), 'live')).toBe(true);
  });

  it('runs only the projects --project names', () => {
    expect(runsProject(cli('--project', 'chromium'), 'live')).toBe(false);
    expect(runsProject(cli('--project', 'chromium'), 'chromium')).toBe(true);
    expect(runsProject(cli('--project=live'), 'live')).toBe(true);
    expect(runsProject(cli('--project=chromium'), 'live')).toBe(false);
  });

  it('takes every value up to the next option, and repeated options', () => {
    expect(runsProject(cli('--project', 'chromium', 'live', '--headed'), 'live')).toBe(true);
    expect(runsProject(cli('--project', 'chromium', '--headed', 'live'), 'live')).toBe(false);
    expect(runsProject(cli('--project', 'chromium', '--project', 'live'), 'live')).toBe(true);
  });

  it('matches as Playwright does: ignoring case, with * wildcards', () => {
    expect(runsProject(cli('--project', 'LIVE'), 'live')).toBe(true);
    expect(runsProject(cli('--project', 'l*'), 'live')).toBe(true);
    expect(runsProject(cli('--project', 'chrom*'), 'live')).toBe(false);
    expect(runsProject(cli('--project', 'li.e'), 'live')).toBe(false);
  });

  it('stops reading options at --', () => {
    expect(runsProject(cli('--', '--project', 'chromium'), 'live')).toBe(true);
  });
});
