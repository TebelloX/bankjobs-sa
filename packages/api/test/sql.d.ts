// Global (script-scope) ambient declaration: db/schema.sql imported as a raw
// string via Vite's ?raw loader. MUST stay import-free so the wildcard module
// declaration registers globally.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
