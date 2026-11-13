import { describe, expect, it } from 'vite-plus/test';
import { meaningOffer, meaningSettingState } from '../src/meaning/setting';

describe('where search by meaning is offered (ADR 0016, decision 5)', () => {
  it('offers it in the desktop app with a keyring, and a computer’s browser, keeping every page', () => {
    expect(meaningOffer({ device: 'desktop', onDisk: true, everyPage: true })).toBe('offered');
    expect(meaningOffer({ device: 'browser', onDisk: true, everyPage: true })).toBe('offered');
  });

  it('needs Every page kept, and a keyring in the desktop app', () => {
    expect(meaningOffer({ device: 'browser', onDisk: true, everyPage: false })).toBe('every-page');
    expect(meaningOffer({ device: 'desktop', onDisk: true, everyPage: false })).toBe('every-page');
    expect(meaningOffer({ device: 'desktop', onDisk: false, everyPage: true })).toBe('keyring');
  });

  it('isn’t offered on a phone yet', () => {
    expect(meaningOffer({ device: 'phone', onDisk: true, everyPage: true })).toBe('phone');
  });

  it('says what it does, and what it needs where it isn’t offered', () => {
    expect(meaningSettingState('offered', { on: false, desktop: false, status: null })).toBe(
      'Finds pages close in meaning to what you search for, below the pages with its words. Downloads 26 MB once, then indexes your pages in the background on this device.',
    );
    expect(
      meaningSettingState('offered', { on: true, desktop: true, status: { pages: 3, total: 10 } }),
    ).toBe(
      'By meaning: 3 of 10 pages so far. Finds pages close in meaning to what you search for, below the pages with its words. Nothing you search for or write leaves this device.',
    );
    expect(meaningSettingState('every-page', { on: true, desktop: false, status: null })).toBe(
      'Needs Keep for offline on Every page: indexing again each session would take minutes.',
    );
    expect(meaningSettingState('keyring', { on: true, desktop: true, status: null })).toBe(
      'Needs Keep for offline on Every page, which needs a keyring here.',
    );
    expect(meaningSettingState('phone', { on: false, desktop: false, status: null })).toBe(
      'Not on phones yet.',
    );
  });
});
