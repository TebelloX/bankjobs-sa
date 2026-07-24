// Share-link builders for the job detail page.
//
// Kept separate from data.ts ON PURPOSE, exactly like freshness.ts: data.ts
// imports the (gitignored) job snapshot JSON, and this module must stay safe
// to import from client-bundled code — it must never drag the snapshot into
// the browser payload. Keep this file dependency-free. (Today only the
// frontmatter of jobs/[slug].astro imports it; the client script reads the
// prebuilt values off data- attributes instead.)
//
// Every href here is built from the page's CANONICAL url, which the caller
// passes in (computed the same way Base.astro builds its <link rel=canonical>).
// Nothing in this file knows the domain, and nothing appends tracking params:
// a shared link is the same clean URL a visitor would bookmark.

export interface ShareSubject {
  /** Job title, e.g. 'Senior Data Analyst'. */
  title: string;
  /** Hiring brand, e.g. 'Absa'. */
  brand: string;
  /** Absolute canonical URL of the job page. */
  url: string;
}

/** The one-line label every channel shares: '<job title> — <brand>'. */
export function shareLabel(title: string, brand: string): string {
  return `${title} — ${brand}`;
}

/**
 * The message body: label, then the URL on its OWN line so WhatsApp (and most
 * mail clients) detect it as a link and render a preview.
 */
export function shareMessage({ title, brand, url }: ShareSubject): string {
  return `${shareLabel(title, brand)}\n${url}`;
}

/**
 * wa.me click-to-chat link with no recipient — WhatsApp asks the sender to
 * pick a contact. A plain anchor, so it works with JavaScript disabled.
 */
export function whatsappShareHref(subject: ShareSubject): string {
  return `https://wa.me/?text=${encodeURIComponent(shareMessage(subject))}`;
}

/**
 * mailto: link with subject and body prefilled. Also a plain anchor, so it
 * works with JavaScript disabled.
 */
export function mailtoShareHref(subject: ShareSubject): string {
  const s = encodeURIComponent(shareLabel(subject.title, subject.brand));
  const body = encodeURIComponent(`${shareMessage(subject)}\n\nvia mybankjobs`);
  return `mailto:?subject=${s}&body=${body}`;
}
