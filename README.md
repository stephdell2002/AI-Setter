# AI Setter

A minimal web app with a chat page where you message an AI appointment setter
that replies like a real human.

- **The brain (HOW it talks)** is baked into the code at `lib/brain.ts` and does
  not change.
- **The training (WHAT it sells)** lives in your Supabase `clients` table, so you
  can edit it any time without touching code. The server reads it fresh on every
  reply.

## Stack

- Next.js 15 (App Router) + TypeScript
- Supabase (Postgres) for the database
- Claude (`claude-sonnet-4-6`) via the Anthropic API, called server-side only

## How it fits together

```
Browser (chat page)  ->  /api/chat (your server)  ->  Supabase + Claude
```

The browser never holds any secret. All keys live on the server.

## Environment variables

Set these three in `.env.local` (local dev) and in Vercel (live app):

| Variable                    | What it is                                            |
| --------------------------- | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | Your Claude API key                                   |
| `SUPABASE_URL`              | `https://rwbpgklepcxczrnltvwj.supabase.co`            |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service_role (secret) key, server only  |

## Database tables

- `clients` — one row holds the setter config and your training fields.
- `leads` — one row per conversation.
- `messages` — chat history (role `user` or `assistant`).

## Teaching your setter

Open your `clients` row in the Supabase Table Editor and fill in any of:

- `system_prompt` — your sales process / SOP
- `active_rules` — your do's and don'ts
- `voice_samples` — examples of your tone
- `business_context` — what you sell, price, booking link

Save, then refresh the chat. The next reply follows your new training.

## Run locally

```bash
npm install
cp .env.local.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000
