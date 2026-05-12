# Hook

A disposable webhook receiver built on Next.js + Cloudflare Workers.

- Open the page → you get a random URL like `https://<host>/h/<id>`
- Send any HTTP request to that URL → it streams into the browser live (SSE)
- The endpoint stays alive for **60 minutes after the last received request**, then 410s
- Webhook payloads are **never persisted** — they're broadcast through a Durable Object and stored only in the receiving browser's `sessionStorage`
- Empty state shows a `curl` snippet you can paste; once requests arrive, pick one from the sidebar to inspect headers, query, and a pretty-printed body

## Architecture

| Piece | Where |
| --- | --- |
| Page UI | `src/app/page.tsx` → `src/components/webhook-tool.tsx` |
| Worker entry (wraps OpenNext) | `worker.ts` |
| Durable Object (per-session broker) | `src/lib/webhook-session.ts` |
| DO binding + migration | `wrangler.jsonc` |

The custom worker intercepts `/h/{id}[/...]` (webhook receiver, any method) and `/s/{id}` (SSE stream) and forwards both to a `WebhookSession` Durable Object keyed by `id`. Everything else falls through to the OpenNext-built Next.js handler.

## Commands

| Command | Action |
| :--- | :--- |
| `npm run dev` | Next.js dev server (UI only — DO routes don't run here) |
| `npm run preview` | Build with OpenNext, run the full worker locally via `wrangler` (recommended for end-to-end testing) |
| `npm run build` | Build production bundle |
| `npm run deploy` | Build + deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `env.d.ts` after editing `wrangler.jsonc` |

`next dev` proxies bindings via miniflare but cannot run the Durable Object class our wrapper exports — for hitting the live endpoint locally, use `npm run preview`.
