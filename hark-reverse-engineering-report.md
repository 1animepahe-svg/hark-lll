# Hark (hark.com) — Reverse-Engineering Report
*Static analysis of the public web surface · methodology: full HTML + all 24 JS chunks (6.45 MB) mirrored and analyzed · deployment `dpl_43vpACitAoHemg5zATXXCP8hBYHa`*

## 1. Product identity
- **Hark Pro** — AI assistant ("A new kind of system for getting things done"), live at hark.com and hark.ai (identical content).
- Twitter/X-news: native iOS app (`id6772362941`) and Android (`com.hark.android`), via Google/Apple sign-in.

## 2. Frontend stack (confirmed)
| Component | Finding |
|---|---|
| Framework | **Next.js App Router + Turbopack** (React Server Components) |
| Bundles | 24 JS chunks (`/_next/static/chunks/*.js?dpl=...`), ~6.45 MB |
| Source maps | **None exposed** (`mapRefs=0`) → minified-only analysis |
| Deployment marker | `data-dpl-id` baked into HTML + `dpl` param required on static assets |

## 3. Backend surface (discovered)
- **`GET /api/sky/iplocate`** — verified live, **unauthenticated**, returns `{city, latitude, longitude, timezone}` (fired at page load; geo-aware routing/personalization). Probe result: `Ibadan / 7.38 / 3.91 / Africa/Lagos`.
- All other API calls are same-origin `/api/*` (no host strings embedded in chunks — relative-URL SPA by design).
- Static asset tree: `/images/favicon-dark.png`, `/images/favicon-light.png`.

## 4. Site routes
`/ · /manifesto · /security · /articles · /careers · /contact-hark · /pricing · /privacy-policy · /terms · /using-hark · /other-policies`

## 5. Third-party profile (thin, deliberate)
| Service | Role |
|---|---|
| Sanity CDN (`w2mhvsaj/production`) | CMS content/images |
| Cloudflare Insights beacon | first-party telemetry only |
| YouTube embed `0PSV7e1KawA` | marketing video |
| — | **No analytics keys** (no Sentry/Posthog/Segment/Amplitude/Clerk/Supabase/Firebase fingerprints found in HTML; JS pass cross-checking) |

## 6. Security architecture (self-described on /security)
- Tokenized vault for user credentials given to agents
- "Open kitchen" — agent actions watchable and cancellable in real time
- Own-models-first inference; "0 data retention" third-party vendors
- Trust/compliance hub promised at trust.hark.com

## 7. Limitations & next steps (if requested)
- The real product (agent chat + vault APIs) is **behind Google/Apple auth** — static analysis can't reach it.
- Optional next probes: unauthenticated route probing of `/api/*` surface (OPTIONS/GET only), and live-account capture analysis.
