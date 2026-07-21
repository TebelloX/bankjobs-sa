import type { Category, SourceId } from './job';
import rulesData from './data/category-rules.json';

interface Rule {
  category: string;
  keywords: string[];
}

interface CompiledRule {
  category: Category;
  matchers: RegExp[];
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a keyword into a case-insensitive, word-boundary regex. Multi-word
 * keywords match as phrases (interior whitespace matches one-or-more spaces).
 * Boundaries use lookarounds on alphanumerics so keywords like `.net` and `IT`
 * still match without being swallowed by neighbouring word characters.
 */
function keywordToRegex(keyword: string): RegExp {
  const body = keyword.trim().split(/\s+/).map(escapeRegex).join('\\s+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

function compile(rules: Rule[]): CompiledRule[] {
  return rules.map((rule) => ({
    category: rule.category as Category,
    matchers: rule.keywords.map(keywordToRegex),
  }));
}

const GLOBAL_RULES = compile(rulesData.global as Rule[]);
const PER_SOURCE_RULES: Record<SourceId, CompiledRule[]> = {
  absa: compile(rulesData.perSource.absa as Rule[]),
  firstrand: compile(rulesData.perSource.firstrand as Rule[]),
  standardbank: compile(rulesData.perSource.standardbank as Rule[]),
  investec: compile(rulesData.perSource.investec as Rule[]),
  gotyme: compile(rulesData.perSource.gotyme as Rule[]),
  nedbank: compile(rulesData.perSource.nedbank as Rule[]),
  discovery: compile(rulesData.perSource.discovery as Rule[]),
};

/**
 * Classify a job into one of the CATEGORIES. Per-source rules are evaluated
 * before global rules, both in array order; the first rule with ANY matching
 * keyword wins. Falls through to 'Other'.
 */
export function categorize(title: string, source: SourceId, sourceCategory?: string): Category {
  const haystack = `${title} ${sourceCategory ?? ''}`;
  const rules = [...PER_SOURCE_RULES[source], ...GLOBAL_RULES];

  for (const rule of rules) {
    for (const matcher of rule.matchers) {
      if (matcher.test(haystack)) return rule.category;
    }
  }

  return 'Other';
}
