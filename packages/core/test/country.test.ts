import { describe, expect, it } from 'vitest';
import { countryCodeFor, countryName } from '../src/index';

const codeCases: Array<[string, string]> = [
  ['South Africa', 'ZA'],
  ['Seychelles', 'SC'],
  ['Tanzania', 'TZ'],
  ['United Republic of Tanzania', 'TZ'],
  ['Kenya', 'KE'],
  ['Mozambique', 'MZ'],
  ['Zambia', 'ZM'],
  ['Botswana', 'BW'],
  ['Ghana', 'GH'],
  ['Mauritius', 'MU'],
  ['Uganda', 'UG'],
  ['Namibia', 'NA'],
  ['Nigeria', 'NG'],
  ['Zimbabwe', 'ZW'],
  ['Lesotho', 'LS'],
  ['Eswatini', 'SZ'],
  ['United Kingdom', 'GB'],
  ['Isle of Man', 'IM'],
  ['Jersey', 'JE'],
  ['Guernsey', 'GG'],
  ['United States', 'US'],
  ['United States of America', 'US'],
  ['China', 'CN'],
  ['India', 'IN'],
  ['United Arab Emirates', 'AE'],
  ['Singapore', 'SG'],
  ['Hong Kong', 'HK'],
  ['Czechia', 'CZ'],
  ['Czech Republic', 'CZ'],
  // case-insensitive + trimming
  ['  south africa  ', 'ZA'],
  ['HONG KONG', 'HK'],
];

describe('countryCodeFor', () => {
  it.each(codeCases)('maps %j -> %s', (name, code) => {
    expect(countryCodeFor(name)).toBe(code);
  });

  it('returns ZZ for unknown names', () => {
    expect(countryCodeFor('Atlantis')).toBe('ZZ');
    expect(countryCodeFor('')).toBe('ZZ');
  });
});

const nameCases: Array<[string, string]> = [
  ['ZA', 'South Africa'],
  ['SC', 'Seychelles'],
  ['TZ', 'Tanzania'],
  ['US', 'United States'],
  ['CZ', 'Czechia'],
  ['NA', 'Namibia'],
  // case-insensitive code lookup
  ['za', 'South Africa'],
];

describe('countryName', () => {
  it.each(nameCases)('maps %s -> %j', (code, name) => {
    expect(countryName(code)).toBe(name);
  });

  it('returns the code itself for unknown codes', () => {
    expect(countryName('ZZ')).toBe('ZZ');
    expect(countryName('XX')).toBe('XX');
  });

  it('round-trips code -> name -> code', () => {
    expect(countryCodeFor(countryName('ZA'))).toBe('ZA');
    expect(countryCodeFor(countryName('SZ'))).toBe('SZ');
  });
});
