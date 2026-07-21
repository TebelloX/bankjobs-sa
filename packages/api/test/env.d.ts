import type { Env } from '../src/types';

// `env` from 'cloudflare:test' is typed from the Worker's bindings.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
