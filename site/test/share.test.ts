import { describe, expect, it } from 'vitest';
import { mailtoShareHref, shareLabel, shareMessage, whatsappShareHref } from '../src/lib/share';

const JOB = {
  title: 'Senior Data Analyst',
  brand: 'Absa',
  url: 'https://mybankjobs.co.za/jobs/absa-90242471/',
};

describe('shareLabel', () => {
  it('joins title and brand with an em dash', () => {
    expect(shareLabel('Senior Data Analyst', 'Absa')).toBe('Senior Data Analyst — Absa');
  });
});

describe('shareMessage', () => {
  it('puts the url on its own line so chat apps linkify it', () => {
    expect(shareMessage(JOB)).toBe(
      'Senior Data Analyst — Absa\nhttps://mybankjobs.co.za/jobs/absa-90242471/',
    );
  });
});

describe('whatsappShareHref', () => {
  it('is a wa.me link with no recipient and a url-encoded text param', () => {
    expect(whatsappShareHref(JOB)).toBe(
      'https://wa.me/?text=' + encodeURIComponent(shareMessage(JOB)),
    );
  });

  it('encodes the separators so the query cannot break out', () => {
    const href = whatsappShareHref(JOB);
    expect(href.startsWith('https://wa.me/?text=')).toBe(true);
    // Exactly one '?' and no bare '&', '#' or newline past the prefix.
    expect(href.slice('https://wa.me/'.length + 1)).not.toMatch(/[?&#\n]/);
    expect(href).toContain('%E2%80%94'); // em dash
    expect(href).toContain('%0A'); // newline before the url
  });

  it('survives titles containing url-significant characters', () => {
    const href = whatsappShareHref({ ...JOB, title: 'Analyst (R&D) #2 ?' });
    expect(href.slice('https://wa.me/'.length + 1)).not.toMatch(/[?&#]/);
    expect(decodeURIComponent(href.split('text=')[1]!)).toContain('Analyst (R&D) #2 ?');
  });
});

describe('mailtoShareHref', () => {
  it('prefills subject and body', () => {
    const href = mailtoShareHref(JOB);
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    const [, query] = href.split('mailto:?');
    const params = new URLSearchParams(query);
    expect(params.get('subject')).toBe('Senior Data Analyst — Absa');
    expect(params.get('body')).toBe(`${shareMessage(JOB)}\n\nvia mybankjobs`);
  });

  it('has no recipient — the sender picks one', () => {
    expect(mailtoShareHref(JOB).startsWith('mailto:?')).toBe(true);
  });
});

describe('share urls carry no tracking params', () => {
  it('embeds the canonical url unchanged', () => {
    for (const href of [whatsappShareHref(JOB), mailtoShareHref(JOB)]) {
      expect(decodeURIComponent(href)).toContain(JOB.url);
      expect(decodeURIComponent(href)).not.toMatch(/utm_|ref=|fbclid/);
    }
  });
});
