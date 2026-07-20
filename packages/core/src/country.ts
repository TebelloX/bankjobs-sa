/**
 * Country reference data. Each entry: [ISO 3166-1 alpha-2 code, display name,
 * ...additional aliases]. The display name is what `countryName` returns for a
 * code; every name and alias is matched case-insensitively by `countryCodeFor`.
 */
const COUNTRIES: ReadonlyArray<readonly [string, string, ...string[]]> = [
  ['ZA', 'South Africa'],
  ['SC', 'Seychelles'],
  ['TZ', 'Tanzania', 'United Republic of Tanzania'],
  ['KE', 'Kenya'],
  ['MZ', 'Mozambique'],
  ['ZM', 'Zambia'],
  ['BW', 'Botswana'],
  ['GH', 'Ghana'],
  ['MU', 'Mauritius'],
  ['UG', 'Uganda'],
  ['NA', 'Namibia'],
  ['NG', 'Nigeria'],
  ['ZW', 'Zimbabwe'],
  ['LS', 'Lesotho'],
  ['SZ', 'Eswatini'],
  ['AO', 'Angola'],
  ['CI', "Côte d'Ivoire", 'Ivory Coast'],
  ['CD', 'Democratic Republic of the Congo', 'DR Congo', 'DRC'],
  ['MW', 'Malawi'],
  ['RW', 'Rwanda'],
  ['SS', 'South Sudan'],
  ['SD', 'Sudan'],
  ['ET', 'Ethiopia'],
  ['CM', 'Cameroon'],
  ['SN', 'Senegal'],
  ['GB', 'United Kingdom'],
  ['IM', 'Isle of Man'],
  ['JE', 'Jersey'],
  ['GG', 'Guernsey'],
  ['US', 'United States', 'United States of America'],
  ['CN', 'China'],
  ['IN', 'India'],
  ['AE', 'United Arab Emirates'],
  ['SG', 'Singapore'],
  ['HK', 'Hong Kong'],
  ['CZ', 'Czechia', 'Czech Republic'],
];

const NAME_TO_CODE = new Map<string, string>();
const CODE_TO_NAME = new Map<string, string>();

for (const [code, displayName, ...aliases] of COUNTRIES) {
  CODE_TO_NAME.set(code.toUpperCase(), displayName);
  NAME_TO_CODE.set(displayName.trim().toLowerCase(), code);
  for (const alias of aliases) {
    NAME_TO_CODE.set(alias.trim().toLowerCase(), code);
  }
}

/**
 * Map a country display name to its ISO 3166-1 alpha-2 code.
 * Matching is case-insensitive on the trimmed input. Unknown -> 'ZZ'.
 */
export function countryCodeFor(name: string): string {
  return NAME_TO_CODE.get(name.trim().toLowerCase()) ?? 'ZZ';
}

/**
 * Map an ISO 3166-1 alpha-2 code back to a display name.
 * Unknown codes are returned unchanged.
 */
export function countryName(code: string): string {
  return CODE_TO_NAME.get(code.trim().toUpperCase()) ?? code;
}
