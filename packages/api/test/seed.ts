import schemaSql from '../../../db/schema.sql?raw';

/**
 * Split a multi-statement SQL script into individual statements for D1's
 * one-statement-at-a-time execute API. Trigger bodies (`CREATE TRIGGER ...
 * BEGIN ...; ...; END;`) contain semicolons that do NOT end the statement, so we
 * track BEGIN/END depth and only break on a `;` at depth 0. Line comments are
 * stripped first (this schema has no string literals containing `;`, `BEGIN`, or
 * `END`, so a keyword scan is sufficient and robust here).
 */
export function splitSqlStatements(sql: string): string[] {
  const src = sql.replace(/--[^\n]*/g, '');
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/[A-Za-z]/.test(ch) && (i === 0 || !/[A-Za-z]/.test(src[i - 1]!))) {
      let j = i;
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
      const word = src.slice(i, j).toUpperCase();
      if (word === 'BEGIN') depth++;
      else if (word === 'END') depth = Math.max(0, depth - 1);
      buf += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ';' && depth === 0) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Apply db/schema.sql to a D1 database. PRAGMA statements are skipped — D1
 * manages `foreign_keys` itself and rejects some PRAGMAs — every other statement
 * (tables, indexes, the FTS5 virtual table, the three triggers, the sources
 * seed) runs verbatim through the real D1 API.
 */
export async function applySchema(db: D1Database): Promise<void> {
  const statements = splitSqlStatements(schemaSql).filter((s) => !/^PRAGMA\b/i.test(s));
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

export interface SeedJob {
  id: string;
  source: string;
  brand: string;
  title: string;
  category: string;
  employmentType: string | null;
  descriptionHtml: string;
  descriptionText: string;
  excerpt: string;
  primaryLocation: string | null;
  rawLocation: string | null;
  country: string;
  applyUrl: string;
  postedDate: string | null;
  status: string;
  locations: { city: string | null; province: string | null }[];
}

// Representative fixtures: SA + international, several categories/sources/
// provinces, one null postedDate (ordering), and one CLOSED job that must never
// surface. Kept small and self-contained — no db/local.db, no network.
export const SEED_JOBS: SeedJob[] = [
  {
    id: 'absa:R-1',
    source: 'absa',
    brand: 'Absa',
    title: 'Branch Teller',
    category: 'Branch & Retail',
    employmentType: 'Full time',
    descriptionHtml: '<p>Serve customers at our Johannesburg branch.</p>',
    descriptionText:
      'Serve customers at our Johannesburg branch handling deposits and withdrawals.',
    excerpt: 'Serve customers at our Johannesburg branch.',
    primaryLocation: 'Johannesburg, Gauteng',
    rawLocation: 'Johannesburg',
    country: 'ZA',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply/R-1',
    postedDate: '2026-07-05',
    status: 'open',
    locations: [{ city: 'Johannesburg', province: 'Gauteng' }],
  },
  {
    id: 'absa:R-2',
    source: 'absa',
    brand: 'Absa',
    title: 'Senior Backend Software Engineer',
    category: 'Software & IT',
    employmentType: 'Full time',
    descriptionHtml: '<p>Build cloud backend services in Python and TypeScript.</p>',
    descriptionText:
      'Build cloud backend services in Python and TypeScript for our engineering platform.',
    excerpt: 'Build cloud backend services in Python.',
    primaryLocation: 'Cape Town, Western Cape',
    rawLocation: 'Cape Town',
    country: 'ZA',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply/R-2',
    postedDate: '2026-07-08',
    status: 'open',
    locations: [{ city: 'Cape Town', province: 'Western Cape' }],
  },
  {
    id: 'firstrand:R-100',
    source: 'firstrand',
    brand: 'FNB',
    title: 'Data Analyst',
    category: 'Data & Analytics',
    employmentType: 'Full time',
    descriptionHtml: '<p>Analyse customer data and build dashboards.</p>',
    descriptionText: 'Analyse customer data and build dashboards using SQL and Python.',
    excerpt: 'Analyse customer data and build dashboards.',
    primaryLocation: 'Durban, KwaZulu-Natal',
    rawLocation: 'Durban',
    country: 'ZA',
    applyUrl: 'https://firstrand.wd3.myworkdayjobs.com/apply/R-100',
    postedDate: '2026-07-06',
    status: 'open',
    locations: [{ city: 'Durban', province: 'KwaZulu-Natal' }],
  },
  {
    id: 'standardbank:R-200',
    source: 'standardbank',
    brand: 'Standard Bank',
    title: 'Risk Manager',
    category: 'Risk & Compliance',
    employmentType: 'Full time',
    descriptionHtml: '<p>Lead operational risk and compliance.</p>',
    descriptionText: 'Lead operational risk and compliance across the corporate bank.',
    excerpt: 'Lead operational risk and compliance.',
    primaryLocation: 'Pretoria, Gauteng',
    rawLocation: 'Pretoria',
    country: 'ZA',
    applyUrl: 'https://standardbank.example/apply/R-200',
    postedDate: '2026-07-07',
    status: 'open',
    locations: [{ city: 'Pretoria', province: 'Gauteng' }],
  },
  {
    id: 'investec:R-50',
    source: 'investec',
    brand: 'Investec',
    title: 'Software Developer',
    category: 'Software & IT',
    employmentType: 'Full time',
    descriptionHtml: '<p>Develop trading software in Java.</p>',
    descriptionText: 'Join our engineering team to develop trading software in Java.',
    excerpt: 'Develop trading software in Java.',
    primaryLocation: 'Sandton, Gauteng',
    rawLocation: 'Sandton',
    country: 'ZA',
    applyUrl: 'https://investec.example/apply/R-50',
    postedDate: '2026-07-04',
    status: 'open',
    locations: [{ city: 'Sandton', province: 'Gauteng' }],
  },
  {
    id: 'sarb:1736',
    source: 'sarb',
    brand: 'SARB',
    title: 'Economist',
    category: 'Finance & Accounting',
    employmentType: 'Full time',
    descriptionHtml: '<p>Conduct economic research and policy analysis.</p>',
    descriptionText: 'Conduct economic research and monetary policy analysis.',
    excerpt: 'Conduct economic research and policy analysis.',
    primaryLocation: 'Pretoria, Gauteng',
    rawLocation: 'Pretoria Head Office',
    country: 'ZA',
    applyUrl: 'https://sarb.example/apply/1736',
    postedDate: '2026-07-03',
    status: 'open',
    locations: [{ city: 'Pretoria', province: 'Gauteng' }],
  },
  {
    id: 'firstrand:R-101',
    source: 'firstrand',
    brand: 'RMB',
    title: 'Operations Administrator',
    category: 'Operations & Admin',
    employmentType: 'Full time',
    descriptionHtml: '<p>Administrative operations support.</p>',
    descriptionText: 'Administrative operations support for the corporate team.',
    excerpt: 'Administrative operations support.',
    primaryLocation: 'Johannesburg, Gauteng',
    rawLocation: 'Johannesburg',
    country: 'ZA',
    applyUrl: 'https://firstrand.wd3.myworkdayjobs.com/apply/R-101',
    postedDate: null,
    status: 'open',
    locations: [{ city: 'Johannesburg', province: 'Gauteng' }],
  },
  {
    id: 'absa:R-3',
    source: 'absa',
    brand: 'Absa',
    title: 'Information Risk Manager',
    category: 'Risk & Compliance',
    employmentType: 'Full time',
    descriptionHtml: '<p>Manage information security risk for Seychelles operations.</p>',
    descriptionText: 'Manage information security risk for our Seychelles operations.',
    excerpt: 'Manage information security risk.',
    primaryLocation: 'Grand Anse',
    rawLocation: 'Grand Anse',
    country: 'SC',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply/R-3',
    postedDate: '2026-07-01',
    status: 'open',
    // No matched city/province — international row, contributes to no SA rollup.
    locations: [],
  },
  {
    id: 'nedbank:R-9',
    source: 'nedbank',
    brand: 'Nedbank',
    title: 'Sales Consultant',
    category: 'Sales',
    employmentType: 'Full time',
    descriptionHtml: '<p>Closed sales role — must never surface.</p>',
    descriptionText: 'Closed sales role in Bloemfontein.',
    excerpt: 'Closed sales role.',
    primaryLocation: 'Bloemfontein, Free State',
    rawLocation: 'Bloemfontein',
    country: 'ZA',
    applyUrl: 'https://nedbank.example/apply/R-9',
    postedDate: '2026-07-02',
    status: 'closed',
    locations: [{ city: 'Bloemfontein', province: 'Free State' }],
  },
];

/** Insert SEED_JOBS (and their locations) via the D1 API; triggers index FTS. */
export async function seedSampleJobs(db: D1Database): Promise<void> {
  const now = '2026-07-10T00:00:00.000Z';
  const stmts: D1PreparedStatement[] = [];
  for (const j of SEED_JOBS) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO jobs (
             id, source, brand, title, category, employment_type,
             description_html, description_text, excerpt,
             primary_location, raw_location, country, apply_url, posted_date,
             content_hash, status, first_seen, last_seen, missed_runs, closed_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?)`,
        )
        .bind(
          j.id,
          j.source,
          j.brand,
          j.title,
          j.category,
          j.employmentType,
          j.descriptionHtml,
          j.descriptionText,
          j.excerpt,
          j.primaryLocation,
          j.rawLocation,
          j.country,
          j.applyUrl,
          j.postedDate,
          `hash-${j.id}`,
          j.status,
          now,
          now,
          now,
        ),
    );
    for (const loc of j.locations) {
      stmts.push(
        db
          .prepare('INSERT INTO job_locations (job_id, city, province) VALUES (?,?,?)')
          .bind(j.id, loc.city ?? '', loc.province),
      );
    }
  }
  await db.batch(stmts);
}

/** Convenience for suites that just want a fully-seeded schema. */
export async function seedAll(db: D1Database): Promise<void> {
  await applySchema(db);
  await seedSampleJobs(db);
}
