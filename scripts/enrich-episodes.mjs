#!/usr/bin/env node
// Fetches the Die Nerd Show RSS feed and enriches each episode with an
// LLM-generated summary + topic tags so the homepage search can find episodes
// by concept, not just exact-word match. Output: src/data/episodes.json.
//
// Idempotent: caches by sha256 of (title + rawDescription); re-runs only
// process new/changed episodes. Override the model via ANTHROPIC_MODEL.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(REPO_ROOT, "src/data/episodes.json");
const RSS_URL = "https://api.riverside.com/hosting/DNlgur7b.rss";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || 4);

const SYSTEM_PROMPT = `You are cataloging episodes of "Die Nerd Show", a German tech podcast covering AI, crypto, chips, semiconductors, global markets, social structures, and tech trends. Hosts: Carlo Matic, Manuel Koelman, Oliver Thylmann, Sebastian Deutsch.

For each episode you'll receive a title and existing show notes (often sparse — sometimes a one-liner). Produce:
- summary: 1-2 neutral German sentences (~120-220 chars) describing what the episode covers.
- tags: 5-12 lowercase topic tags — concrete topics, technologies, companies, people, themes. Use German or English terms as the show would (e.g. "ki", "openai", "tsmc", "ethereum", "merge", "metaverse", "regulierung", "chips"). Avoid generic tags like "podcast", "tech", "nerds".

Rules:
- Do not invent specific facts not implied by the title or notes.
- If notes are sparse, infer broader topic tags from the title.
- Keep summaries factual and topic-focused, not promotional.`;

const SCHEMA = {
    type: "object",
    properties: {
        summary: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "tags"],
    additionalProperties: false,
};

function stripHtml(html) {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'");
}

function unwrapCdata(s) {
    const m = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return m ? m[1] : s;
}

function pickTag(item, tag) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
    const m = item.match(re);
    return m ? unwrapCdata(m[1]).trim() : "";
}

function pickEnclosureUrl(item) {
    const m = item.match(/<enclosure\b[^>]*\burl="([^"]*)"/);
    return m ? m[1] : "";
}

function extractEpisodeNumber(title) {
    const m = title.match(/#(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function parseRss(xml) {
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const x = m[1];
        const title = decodeEntities(pickTag(x, "title"));
        const rawDescription = stripHtml(
            decodeEntities(pickTag(x, "description")),
        );
        const pubDate = pickTag(x, "pubDate");
        const guid = pickTag(x, "guid");
        const audioUrl = pickEnclosureUrl(x);
        const durationStr = pickTag(x, "itunes:duration");
        const durationSec = durationStr ? parseInt(durationStr, 10) || 0 : 0;
        items.push({
            id: guid || audioUrl,
            title,
            episodeNumber: extractEpisodeNumber(title),
            pubDate,
            audioUrl,
            durationSec,
            rawDescription,
        });
    }
    return items;
}

function contentHash(ep) {
    return crypto
        .createHash("sha256")
        .update(`${ep.title}|||${ep.rawDescription}`)
        .digest("hex")
        .slice(0, 16);
}

async function enrichOne(client, ep) {
    const userText = `Title: ${ep.title}\n\nExisting notes:\n${ep.rawDescription || "(none)"}`;
    const response = await client.messages.create({
        model: MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: userText }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text block in response");
    const parsed = JSON.parse(textBlock.text);
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.tags)) {
        throw new Error("response did not match schema");
    }
    return {
        summary: parsed.summary.trim(),
        tags: parsed.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    };
}

async function runWithConcurrency(items, limit, worker) {
    let next = 0;
    const results = new Array(items.length);
    async function runner() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: limit }, runner));
    return results;
}

async function loadCache() {
    try {
        const text = await fs.readFile(OUTPUT, "utf8");
        const arr = JSON.parse(text);
        return new Map(arr.map((e) => [e.id, e]));
    } catch {
        return new Map();
    }
}

async function writeOutput(episodes) {
    // Newest-first
    episodes.sort((a, b) => +new Date(b.pubDate) - +new Date(a.pubDate));
    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, JSON.stringify(episodes, null, 2));
}

async function main() {
    const rssOnly = process.argv.includes("--rss-only");

    if (!rssOnly && !process.env.ANTHROPIC_API_KEY) {
        console.error("Missing ANTHROPIC_API_KEY. Export it, or run with --rss-only to skip enrichment.");
        process.exit(1);
    }

    console.log(`Fetching RSS feed: ${RSS_URL}`);
    const xml = await (await fetch(RSS_URL)).text();
    const items = parseRss(xml);
    console.log(`Parsed ${items.length} episodes from RSS`);

    if (rssOnly) {
        const out = items.map((ep) => ({
            ...ep,
            sourceHash: contentHash(ep),
            summary: ep.rawDescription || ep.title,
            tags: [],
        }));
        await writeOutput(out);
        console.log(`\nWrote ${out.length} episodes (RSS only, no LLM enrichment) → ${path.relative(REPO_ROOT, OUTPUT)}`);
        return;
    }

    const cache = await loadCache();
    const client = new Anthropic();

    let processed = 0;
    let reused = 0;
    let failed = 0;
    const enriched = new Array(items.length);

    await runWithConcurrency(items, CONCURRENCY, async (ep, idx) => {
        const sourceHash = contentHash(ep);
        const cached = cache.get(ep.id);
        const isRealEnrichment =
            cached &&
            Array.isArray(cached.tags) &&
            cached.tags.length > 0 &&
            cached.enrichedBy;
        if (cached && cached.sourceHash === sourceHash && isRealEnrichment) {
            enriched[idx] = { ...cached, ...ep, sourceHash };
            reused++;
            return;
        }
        try {
            const { summary, tags } = await enrichOne(client, ep);
            enriched[idx] = { ...ep, sourceHash, summary, tags, enrichedBy: MODEL };
            processed++;
            console.log(`[${idx + 1}/${items.length}] ✓ ${ep.title.slice(0, 80)}`);
        } catch (err) {
            failed++;
            console.log(`[${idx + 1}/${items.length}] ✗ ${ep.title.slice(0, 60)} — ${err.message}`);
            enriched[idx] = {
                ...ep,
                sourceHash,
                summary: ep.rawDescription || ep.title,
                tags: [],
            };
        }
        // Flush after each completion so an interrupt preserves progress.
        await writeOutput(enriched.filter(Boolean));
    });

    await writeOutput(enriched);
    console.log(
        `\nWrote ${enriched.length} episodes → ${path.relative(REPO_ROOT, OUTPUT)}`,
    );
    console.log(
        `  ${processed} enriched via ${MODEL}, ${reused} reused from cache, ${failed} failed (used raw notes as fallback)`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
