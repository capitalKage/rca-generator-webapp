/**
 * RCA Generator — Cloudflare Worker
 * ----------------------------------
 * Two jobs, both intentionally kept out of the browser:
 *   1. Check the shared team password before doing anything.
 *   2. Call the Anthropic API with a server-held API key and hand back a
 *      strict JSON object the frontend uses to fill the RCA template.
 *
 * Secrets (set with `wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY   your Claude API key
 *   APP_PASSWORD        the shared password the team logs in with
 *
 * Optional variable (wrangler.toml [vars] or `wrangler secret put`):
 *   CLAUDE_MODEL         defaults to claude-sonnet-5
 *   ALLOWED_ORIGIN        defaults to "*" — set this to your GitHub Pages
 *                         origin (e.g. https://yourorg.github.io) once you
 *                         know it, to stop other sites from using your key.
 */

const DEFAULT_MODEL = "claude-sonnet-5";

const SYSTEM_PROMPT = `You are helping fill out a standardized single-slide RCA (Root Cause Analysis)
template for internal telematics/connected-car incident tickets (Jira). You will be given the raw
fields of one ticket (key, summary, type, status, resolution, dates, description, comments).

Your job is to produce SHORT, template-ready text for each field below. Follow these rules
strictly — they exist because the destination is a fixed-size PowerPoint table cell, and text
that's too long visibly breaks the layout:

- NEVER invent facts, numbers, dates, VINs, or root causes that are not stated or strongly implied
  by the ticket text. If the ticket doesn't document something, say so plainly (e.g. "Not documented
  in ticket") rather than guessing.
- Keep "incident", "root_cause", "impact_detail", "interim", "permanent", and "monitoring" to
  ONE to TWO sentences each (roughly 20–40 words). Do not write paragraphs.
- "short_incident" is a single one-line restatement (under 20 words) for a second, smaller slide.
- "impacted" MUST be very short — a word or two, under 12 characters (e.g. "Multiple", "3 VINs",
  "1 (known)", "Unknown", "N/A"). Never a sentence.
- "rc_clear" is "Y" if a root cause is clearly stated or strongly implied by the ticket, "N" if the
  ticket only describes symptoms with no identified cause, or "N/A" if this ticket isn't actually an
  incident (e.g. a planned configuration change, or a pure tracking/process ticket).
- "phase" is one of "Investigation" (root cause still unknown / actively being chased),
  "Root Cause" (cause just identified, no fix yet — rarely used), "Implementation" (a fix or
  workaround exists but is not confirmed as the final/permanent fix), or "Verification" (a fix has
  been deployed and confirmed, or the ticket is closed/resolved).
- "impact" is "Y" unless the ticket is clearly not a customer-impacting incident (e.g. a planned
  change), in which case use "N".
- Dates (interim_date, permanent_date, monitoring_date) must be MM/DD/YYYY, derived from the actual
  comment/update dates in the ticket. Use "N/A" if that stage isn't documented or doesn't apply.
- "diagram" is an array of exactly 4 short phrases (2–6 words each) describing a plausible
  cause→effect→fix flow based on the ticket description. You may use a "\\n" inside a phrase to
  break it onto two lines for a small box. This is illustrative, not verified engineering fact.
- If the ticket has an empty description and no comments, do not fabricate detail — say so in
  "incident" and "root_cause", set "rc_clear" to "N", and keep other fields minimal/"N/A".

Return your answer ONLY via the fill_rca tool call — no prose.`;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Password",
    "Access-Control-Max-Age": "86400",
  };
}

const FILL_RCA_TOOL = {
  name: "fill_rca",
  description: "Structured RCA content for one ticket, ready to drop into the template.",
  input_schema: {
    type: "object",
    properties: {
      incident: { type: "string" },
      short_incident: { type: "string" },
      root_cause: { type: "string" },
      rc_clear: { type: "string", enum: ["Y", "N", "N/A"] },
      phase: { type: "string", enum: ["Investigation", "Root Cause", "Implementation", "Verification"] },
      impact: { type: "string", enum: ["Y", "N"] },
      impacted: { type: "string" },
      impact_detail: { type: "string" },
      interim: { type: "string" },
      interim_date: { type: "string" },
      permanent: { type: "string" },
      permanent_date: { type: "string" },
      monitoring: { type: "string" },
      monitoring_date: { type: "string" },
      diagram: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
    },
    required: [
      "incident", "short_incident", "root_cause", "rc_clear", "phase", "impact", "impacted",
      "impact_detail", "interim", "interim_date", "permanent", "permanent_date",
      "monitoring", "monitoring_date", "diagram",
    ],
  },
};

async function handleSummarize(request, env, origin) {
  const password = request.headers.get("X-App-Password") || "";
  if (!env.APP_PASSWORD || password !== env.APP_PASSWORD) {
    return new Response(JSON.stringify({ error: "Invalid password." }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  let ticket;
  try {
    ticket = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Bad JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const userContent = `Ticket JSON:\n${JSON.stringify(ticket, null, 2)}`;

  const model = env.CLAUDE_MODEL || DEFAULT_MODEL;

  const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: [FILL_RCA_TOOL],
      tool_choice: { type: "tool", name: "fill_rca" },
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!anthropicResp.ok) {
    const errText = await anthropicResp.text();
    return new Response(JSON.stringify({ error: "Anthropic API error", detail: errText }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  const data = await anthropicResp.json();
  const toolUse = (data.content || []).find((b) => b.type === "tool_use" && b.name === "fill_rca");
  if (!toolUse) {
    return new Response(JSON.stringify({ error: "Model did not return structured output.", raw: data }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  return new Response(JSON.stringify(toolUse.input), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function handleCheckPassword(request, env, origin) {
  const password = request.headers.get("X-App-Password") || "";
  const ok = !!env.APP_PASSWORD && password === env.APP_PASSWORD;
  return new Response(JSON.stringify({ ok }), {
    status: ok ? 200 : 401,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (url.pathname === "/summarize" && request.method === "POST") {
      return handleSummarize(request, env, origin);
    }
    if (url.pathname === "/check-password" && request.method === "POST") {
      return handleCheckPassword(request, env, origin);
    }
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  },
};
