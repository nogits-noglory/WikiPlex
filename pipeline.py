#!/usr/bin/env python3
"""
WikiFold - Classification Pipeline
Usage:  python pipeline.py "French Revolution"
        python pipeline.py --random
        python pipeline.py              (interactive)

Requires: pip install requests requests python-dotenv psycopg2-binary
Outputs:  PostgreSQL (primary) + graph.json (local backup) + curricula/
"""

import os
import sys
import json
import time
import re
import requests
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

# Optional DB import — pipeline works without it (writes graph.json only)
try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    PG_AVAILABLE = True
except ImportError:
    PG_AVAILABLE = False

# --- Setup ---
BASE_DIR       = Path(__file__).parent
GRAPH_PATH     = BASE_DIR / "graph.json"
CURRICULA_DIR  = BASE_DIR / "curricula"
LAST_RESP_PATH = BASE_DIR / "last_response.txt"

load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost/wikifold")

# --- DB helpers ---
def get_db_conn():
    if not PG_AVAILABLE:
        return None
    try:
        return psycopg2.connect(DATABASE_URL)
    except Exception as e:
        warn(f"DB connection failed: {e}. Writing graph.json only.")
        return None

def db_write_node(conn, node: dict):
    """Upsert a classified node into Postgres."""
    if conn is None:
        return
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO nodes (
            id, title, classified, article_type,
            depth_score, shareability_score, weird_factor,
            curriculum_worthy, curiosity_hook,
            primary_domain, domains, era, primary_geography,
            geography, key_figures, linguistic_root,
            related_concepts, disambiguation_risks,
            nav_style_signal, gap_assessment, classified_at, visit_count
        ) VALUES (
            %s,%s,%s,%s, %s,%s,%s, %s,%s, %s,%s,%s,%s,
            %s,%s,%s, %s,%s, %s,%s,%s, 1
        )
        ON CONFLICT (id) DO UPDATE SET
            title               = EXCLUDED.title,
            classified          = EXCLUDED.classified,
            article_type        = EXCLUDED.article_type,
            depth_score         = EXCLUDED.depth_score,
            shareability_score  = EXCLUDED.shareability_score,
            weird_factor        = EXCLUDED.weird_factor,
            curriculum_worthy   = EXCLUDED.curriculum_worthy,
            curiosity_hook      = EXCLUDED.curiosity_hook,
            primary_domain      = EXCLUDED.primary_domain,
            domains             = EXCLUDED.domains,
            era                 = EXCLUDED.era,
            primary_geography   = EXCLUDED.primary_geography,
            geography           = EXCLUDED.geography,
            key_figures         = EXCLUDED.key_figures,
            linguistic_root     = EXCLUDED.linguistic_root,
            related_concepts    = EXCLUDED.related_concepts,
            disambiguation_risks= EXCLUDED.disambiguation_risks,
            nav_style_signal    = EXCLUDED.nav_style_signal,
            gap_assessment      = EXCLUDED.gap_assessment,
            classified_at       = EXCLUDED.classified_at,
            visit_count         = nodes.visit_count + 1
    """, (
        node["id"], node["title"], True, node.get("article_type"),
        node.get("depth_score"), node.get("shareability_score"), node.get("weird_factor"),
        node.get("curriculum_worthy"), node.get("curiosity_hook"),
        node.get("primary_domain"),
        PgJson(node["domains"]) if node.get("domains") else None,
        node.get("era"), node.get("primary_geography"),
        PgJson(node["geography"]) if node.get("geography") else None,
        PgJson(node["key_figures"]) if node.get("key_figures") else None,
        node.get("linguistic_root"),
        PgJson(node["related_concepts"]) if node.get("related_concepts") else None,
        PgJson(node["disambiguation_risks"]) if node.get("disambiguation_risks") else None,
        node.get("nav_style_signal"), node.get("gap_assessment"),
        node.get("visited_at"),
    ))
    # Remove from frontier if it was there
    cur.execute("DELETE FROM frontier WHERE id = %s", (node["id"],))
    cur.close()

def db_write_edges(conn, edges: list):
    if conn is None:
        return
    cur = conn.cursor()
    for e in edges:
        cur.execute("""
            INSERT INTO edges (from_node, to_node, edge_type, predicate, weight, edge_source, source_sentence, created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (from_node, to_node, edge_type, predicate) DO NOTHING
        """, (
            e["from"], e["to"], e.get("type","structural"),
            e.get("predicate","links to"), e.get("weight",1.0),
            e.get("source","wikipedia_links"), e.get("source_sentence"),
            e.get("created_at"),
        ))
    cur.close()

def db_write_frontier(conn, frontier_updates: list):
    if conn is None:
        return
    cur = conn.cursor()
    for f in frontier_updates:
        cur.execute("""
            INSERT INTO frontier (id, title, linked_from)
            VALUES (%s, %s, %s)
            ON CONFLICT (id) DO NOTHING
        """, (f["id"], f.get("title", f["id"]), f.get("linked_from")))
    cur.close()

def db_write_curriculum(conn, node_id: str, curriculum_data: dict):
    if conn is None:
        return
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO curricula (node_id, data, generated_at)
        VALUES (%s, %s, NOW())
        ON CONFLICT (node_id) DO UPDATE SET
            data         = EXCLUDED.data,
            generated_at = NOW()
    """, (node_id, PgJson(curriculum_data)))
    cur.close()

def db_emit_event(conn, event_type: str, node_id: str, payload: dict):
    if conn is None:
        return
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO graph_events (event_type, node_id, payload)
        VALUES (%s, %s, %s)
    """, (event_type, node_id, PgJson(payload)))
    cur.close()

API_KEY = os.getenv("LLM_API_KEY")
MODEL   = os.getenv("MODEL", "claude-sonnet-4-20250514")

if not API_KEY:
    print("\n  ERROR: LLM_API_KEY not found in .env\n")
    sys.exit(1)

# --- Colors ---
RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
GOLD   = "\033[33m"
CYAN   = "\033[36m"
GREEN  = "\033[32m"
RED    = "\033[31m"
SILVER = "\033[37m"

def log(msg, color=SILVER):   print(f"{color}{msg}{RESET}")
def ok(msg):                   print(f"{GREEN}  ✓ {msg}{RESET}")
def warn(msg):                 print(f"{GOLD}  ⚠ {msg}{RESET}")
def err(msg):                  print(f"{RED}  ✗ {msg}{RESET}")
def dim(msg):                  print(f"{DIM}    {msg}{RESET}")

# --- Graph store ---
def load_graph() -> dict:
    if not GRAPH_PATH.exists():
        return {
            "nodes": {},
            "edges": [],
            "frontier": {},
            "meta": {
                "created": datetime.now(timezone.utc).isoformat(),
                "total_runs": 0
            }
        }
    return json.loads(GRAPH_PATH.read_text(encoding="utf-8"))

def save_graph(graph: dict):
    GRAPH_PATH.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")

# --- Wikipedia ---
def fetch_wikipedia(title: str) -> dict:
    base = "https://en.wikipedia.org/w/api.php"
    params_text = {
        "action": "query", "titles": title,
        "prop": "extracts", "exintro": False,
        "explaintext": True, "redirects": 1,
        "format": "json", "origin": "*"
    }
    params_links = {
        "action": "query", "titles": title,
        "prop": "links", "pllimit": "max",
        "plnamespace": 0, "redirects": 1,
        "format": "json", "origin": "*"
    }

    headers = {"User-Agent": "WikiFold/0.1 (learning graph project)"}
    text_resp  = requests.get(base, params=params_text,  headers=headers, timeout=15)
    links_resp = requests.get(base, params=params_links, headers=headers, timeout=15)

    text_resp.raise_for_status()
    links_resp.raise_for_status()

    text_pages  = list(text_resp.json()["query"]["pages"].values())
    links_pages = list(links_resp.json()["query"]["pages"].values())

    page = text_pages[0]
    if "missing" in page:
        raise ValueError(f'No Wikipedia article found for "{title}"')

    article_text = page.get("extract", "")
    if len(article_text) < 100:
        raise ValueError(f'Article "{title}" is too short to classify')

    # Truncate to ~10000 chars to stay within token budget
    truncated = article_text[:10000] + "\n[article truncated]" \
        if len(article_text) > 10000 else article_text

    outbound_links = [l["title"] for l in links_pages[0].get("links", [])]
    word_count = len(article_text.split())

    return {
        "title":          page["title"],
        "text":           truncated,
        "outbound_links": outbound_links,
        "word_count":     word_count,
    }

# --- Preclassifier ---─
def preclassify(title: str, text: str, word_count: int) -> dict:
    is_list  = bool(re.match(r"^(list of|index of|outline of|glossary of)", title, re.I))
    is_stub  = word_count < 150
    is_disam = bool(re.search(r"may refer to|disambiguation", text[:500], re.I))
    return {
        "is_list":           is_list,
        "is_stub":           is_stub,
        "is_disambiguation": is_disam,
        "skip":              is_list or is_stub or is_disam,
    }

# --- Prompt builder ---
def build_prompt(title: str, text: str, outbound_links: list) -> tuple[str, str]:
    link_list = ", ".join(outbound_links[:150])

    system = (
        "You are WikiFold's knowledge engine. You read Wikipedia articles and return a single, "
        "precise JSON object. You never return markdown fences, preamble, or trailing text. "
        "You never hallucinate facts. Every claim you make must be supportable from the article "
        "text provided. If the article does not contain enough information to answer a field "
        "confidently, you use null rather than guessing."
    )

    user = f"""Analyze this Wikipedia article and return a single JSON object with three top-level keys: "classification", "triples", and "curriculum".

ARTICLE TITLE: {title}

OUTBOUND LINKS (these are the Wikipedia articles this article links to):
{link_list}

ARTICLE TEXT:
---
{text}
---

Return exactly this structure:

{{
  "classification": {{
    "title": "Canonical display name for this article",
    "article_type": "canonical | curiosity | stub | list",
    "depth_score": 0,
    "shareability_score": 0,
    "weird_factor": 0,
    "curriculum_worthy": true,
    "curiosity_hook": "One sentence. The single most interesting, surprising, or strange thing about this subject. Write it as a fact, not a tease.",
    "primary_domain": "Single string. Choose from: mathematics, physics, chemistry, biology, medicine, psychology, philosophy, linguistics, history, politics, economics, law, technology, computing, engineering, art, literature, music, film, religion, mythology, geography, anthropology, sociology, sports, food, other",
    "domains": ["Array of all applicable domains from the list above"],
    "era": "ancient | medieval | early_modern | modern | contemporary | timeless",
    "primary_geography": "Single most relevant country or region, or null",
    "geography": ["Array of all relevant countries or regions"],
    "key_figures": ["Names of people central to this article"],
    "linguistic_root": "The etymological origin of the article subject name, or null. Example: Greek: arithmos, meaning number",
    "related_concepts": ["3 to 6 concepts closely related to this subject that may not be directly linked"],
    "disambiguation_risks": ["Terms or concepts this subject is commonly confused with"],
    "nav_style_signal": "conceptual | biographical | geographical | chronological",
    "gap_assessment": "One paragraph describing what important context, perspectives, or information is absent from this Wikipedia article. Be specific. Null if the article is comprehensive."
  }},

  "triples": [
    {{
      "subject": "The article subject",
      "predicate": "Choose from the predicate vocabulary below",
      "object": "The target entity or concept",
      "object_is_link": true,
      "object_wiki_title": "Exact Wikipedia article title if object_is_link is true, else null",
      "source_sentence": "The exact sentence from the article that supports this triple",
      "edge_type": "interpersonal | geographical | temporal | categorical | etymological | positional"
    }}
  ],

  "curriculum": {{
    "summary": "2 to 3 sentence overview of the subject suitable for a student encountering it for the first time",
    "gaps": ["Important concepts or context MISSING from the Wikipedia article that a student would need. Be specific. Empty array if none."],
    "dictionary": [
      {{ "term": "Key term", "definition": "Clear concise definition", "fromWiki": true }}
    ],
    "people": [
      {{ "name": "Full name", "role": "Their significance to this subject", "fromWiki": true }}
    ],
    "timeline": [
      {{ "date": "Year or date range", "event": "What happened", "significance": "Why it matters", "fromWiki": true }}
    ],
    "flashcards": [
      {{ "type": "term | person | event | concept", "question": "Specific unambiguous question answerable in 1 to 10 words", "answer": "Concise factual answer", "fromWiki": true }}
    ],
    "pretest": [
      {{ "question": "Multiple choice question", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "Why this answer is correct" }}
    ],
    "quiz": [
      {{ "question": "Question testing understanding", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "Explanation of correct answer", "tier": 0 }}
    ],
    "resources": {{
      "furtherReading": [
        {{ "title": "Resource title", "url": "https://...", "source": "Source name", "description": "What this covers" }}
      ],
      "courses": [
        {{ "title": "Course or video title", "url": "https://...", "platform": "Platform name", "description": "What this covers" }}
      ]
    }}
  }}
}}

RULES FOR classification:
- article_type: "canonical" if depth_score >= 7 and the article has substantial content. "curiosity" if depth_score 4-6 or weird_factor >= 7. "stub" if very short or highly obscure. "list" if primarily a list.
- depth_score: 0-10. Score conceptual richness, sourcing quality, and educational value.
- shareability_score: 0-10. How likely someone is to share this.
- weird_factor: 0-10. How surprising, strange, or counterintuitive the subject is.
- curiosity_hook: Must be a genuine fact. Bad: "This covers an important event." Good: "The Great Molasses Flood of 1919 moved at 35 mph, killing 21 people."
- nav_style_signal: How would most people navigate away? biographical/geographical/chronological/conceptual.
- era: Use "timeless" for mathematics, logic, natural laws.

RULES FOR triples:
- Extract 6 to 15 triples. Every triple must include source_sentence copied exactly from the text.
- object_is_link must be true only if the object appears in the outbound links list above.
- Use ONLY these predicates:
  INTERPERSONAL: married to, parent of, child of, sibling of, allied with, opposed by, mentored by, collaborated with, succeeded by, preceded by as leader
  POSITIONAL: served as, founded, led, member of, employed by, created, invented, authored, directed
  GEOGRAPHICAL: born in, died in, located in, originated in, conquered, invaded, capital of
  TEMPORAL: occurred during, caused by, resulted in, contemporaneous with
  CATEGORICAL: type of, subfield of, instance of, part of, used in
  ETYMOLOGICAL: derived from, root meaning, synonym of, antonym of, also known as
- Do not duplicate triples.

RULES FOR curriculum:
- dictionary: 8-14 entries. fromWiki false if term not in article but important.
- people: 4-8. fromWiki false if not mentioned.
- timeline: 6-12 chronological events. Omit if no meaningful chronology.
- flashcards: exactly 16 cards, mixed types.
- pretest: exactly 5 challenging questions.
- quiz: exactly 12 questions. 4 easy (tier 0), 4 medium (tier 1), 4 hard (tier 2).
- All questions: exactly 4 options, correctIndex 0-based.
- furtherReading: 4-6 entries, real URLs only.
- courses: 3-5 from real platforms.
- For stubs: return only summary and a few dictionary entries. Skip flashcards/pretest/quiz.
- Do not hallucinate."""

    return system, user

# --- API call ---
def call_api(system: str, user: str) -> str:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key":         API_KEY,
            "llm-version": "2023-06-01",
            "content-type":      "application/json",
        },
        json={
            "model":      MODEL,
            "max_tokens": 6000,
            "system":     system,
            "messages":   [{"role": "user", "content": user}],
        },
        timeout=120,
    )
    if not resp.ok:
        data = resp.json()
        raise RuntimeError(f"LLM API {resp.status_code}: {data.get('error', {}).get('message', 'unknown')}")
    return resp.json()["content"][0]["text"]

# --- Parser ---
def parse_response(raw: str) -> dict:
    cleaned = re.sub(r"^```json\s*", "", raw, flags=re.I)
    cleaned = re.sub(r"^```\s*",     "", cleaned, flags=re.I)
    cleaned = re.sub(r"```\s*$",     "", cleaned).strip()

    parsed = json.loads(cleaned)

    if not all(k in parsed for k in ("classification", "triples", "curriculum")):
        raise ValueError("Response missing required top-level keys")

    c = parsed["classification"]

    valid_types = {"canonical", "curiosity", "stub", "list"}
    if c.get("article_type") not in valid_types:
        c["article_type"] = "stub"

    valid_eras = {"ancient", "medieval", "early_modern", "modern", "contemporary", "timeless"}
    if c.get("era") not in valid_eras:
        c["era"] = "timeless"

    valid_nav = {"conceptual", "biographical", "geographical", "chronological"}
    if c.get("nav_style_signal") not in valid_nav:
        c["nav_style_signal"] = "conceptual"

    if not isinstance(parsed["triples"], list):
        parsed["triples"] = []

    parsed["triples"] = [
        t for t in parsed["triples"]
        if t.get("subject") and t.get("predicate") and t.get("object") and t.get("source_sentence")
    ]

    if parsed["curriculum"].get("quiz"):
        for q in parsed["curriculum"]["quiz"]:
            if not isinstance(q.get("tier"), int):
                q["tier"] = 1
            q["tier"] = max(0, min(2, q["tier"]))

    return parsed

# --- Graph updates ---
def extract_graph_updates(title: str, parsed: dict, outbound_links: list) -> tuple:
    c = parsed["classification"]
    triples = parsed["triples"]
    now = datetime.now(timezone.utc).isoformat()

    node = {
        "id":                  title,
        "title":               c.get("title") or title,
        "classified":          True,
        "article_type":        c.get("article_type"),
        "depth_score":         c.get("depth_score"),
        "shareability_score":  c.get("shareability_score"),
        "weird_factor":        c.get("weird_factor"),
        "curriculum_worthy":   c.get("curriculum_worthy"),
        "curiosity_hook":      c.get("curiosity_hook"),
        "primary_domain":      c.get("primary_domain"),
        "domains":             c.get("domains"),
        "era":                 c.get("era"),
        "primary_geography":   c.get("primary_geography"),
        "geography":           c.get("geography"),
        "key_figures":         c.get("key_figures"),
        "linguistic_root":     c.get("linguistic_root"),
        "related_concepts":    c.get("related_concepts"),
        "disambiguation_risks":c.get("disambiguation_risks"),
        "nav_style_signal":    c.get("nav_style_signal"),
        "gap_assessment":      c.get("gap_assessment"),
        "visited_at":          now,
    }

    # All outbound links become frontier nodes and structural edges immediately.
    # This is the base threading - the raw directed Wikipedia link graph.
    # Inferred edges layer on top as enrichment.
    frontier_updates = [
        {"id": link, "title": link, "classified": False, "linked_from": title}
        for link in outbound_links if link != title
    ]

    structural_edges = [
        {
            "from":       title,
            "to":         link,
            "type":       "structural",
            "predicate":  "links to",
            "weight":     1.0,
            "source":     "wikipedia_links",
            "created_at": now,
        }
        for link in outbound_links if link != title
    ]

    inferred_edges = [
        {
            "from":            title,
            "to":              t["object_wiki_title"],
            "type":            t["edge_type"],
            "predicate":       t["predicate"],
            "weight":          0.8,
            "source":          "ai_inference",
            "source_sentence": t["source_sentence"],
            "created_at":      now,
        }
        for t in triples
        if t.get("object_is_link") and t.get("object_wiki_title")
    ]

    # Where an inferred edge exists for a link, use it instead of the bare structural one.
    # Structural edges remain for all other outbound links.
    inferred_targets = {e["to"] for e in inferred_edges}
    base_edges = [e for e in structural_edges if e["to"] not in inferred_targets]
    all_edges = base_edges + inferred_edges

    return node, frontier_updates, all_edges

# --- Display ---
def print_node(node: dict):
    print()
    log(f"  {BOLD}{node['title']}{RESET}", GOLD)
    dim(f"type         {node['article_type']}")
    dim(f"depth        {node['depth_score']}/10")
    dim(f"weird        {node['weird_factor']}/10")
    dim(f"share        {node['shareability_score']}/10")
    dim(f"domain       {node['primary_domain']}")
    dim(f"era          {node['era']}")
    dim(f"geography    {node['primary_geography'] or 'none'}")
    dim(f"curriculum   {'yes' if node['curriculum_worthy'] else 'no'}")
    if node.get("curiosity_hook"):
        print()
        log(f'  "{node["curiosity_hook"]}"', CYAN)
    print()

def print_summary(graph: dict, node: dict, structural_edges: list, inferred_edges: list, frontier_updates: list):
    new_frontier = sum(1 for f in frontier_updates if f["id"] not in graph["nodes"])
    log("─" * 60, DIM)
    ok(f"Node classified:   {node['title']}")
    ok(f"Structural edges:  {len(structural_edges)}  (Wikipedia links → frontier threading)")
    ok(f"Inferred edges:    {len(inferred_edges)}  (AI typed relationships)")
    ok(f"Frontier added:    {new_frontier}")
    ok(f"Total nodes:       {len(graph['nodes'])}")
    ok(f"Total edges:       {len(graph['edges'])}")
    ok(f"Total frontier:    {len(graph['frontier'])}")
    log("─" * 60, DIM)

# --- Main pipeline ---
def run(input_title: str):
    print()
    log("╔══════════════════════════════════════════╗", GOLD)
    log("║          WikiFold Pipeline v0.1          ║", GOLD)
    log("╚══════════════════════════════════════════╝", GOLD)
    print()

    graph = load_graph()

    # Already classified?
    if graph["nodes"].get(input_title, {}).get("classified"):
        warn(f'"{input_title}" is already in the graph.')
        dim("Delete the node from graph.json to reclassify.")
        print_node(graph["nodes"][input_title])
        return

    # Step 1: Fetch
    log(f'Fetching Wikipedia: "{input_title}"...', SILVER)
    try:
        wiki = fetch_wikipedia(input_title)
    except Exception as e:
        err(str(e))
        sys.exit(1)
    ok(f'Fetched "{wiki["title"]}" - {wiki["word_count"]} words, {len(wiki["outbound_links"])} outbound links')

    # Step 2: Preclassify
    pre = preclassify(wiki["title"], wiki["text"], wiki["word_count"])
    if pre["is_disambiguation"]:
        warn(f'"{wiki["title"]}" is a disambiguation page. Writing stub node.')
        stub_node = {
            "id": wiki["title"], "title": wiki["title"], "classified": True,
            "article_type": "stub", "curriculum_worthy": False,
            "visited_at": datetime.now(timezone.utc).isoformat(),
        }
        graph["nodes"][wiki["title"]] = stub_node
        save_graph(graph)
        conn = get_db_conn()
        if conn:
            try:
                db_write_node(conn, stub_node)
                conn.commit()
                ok("Stub node written to PostgreSQL")
            except Exception as e:
                err(f"PostgreSQL write failed: {e}")
                conn.rollback()
            finally:
                conn.close()
        return
    if pre["is_stub"]:
        warn(f'"{wiki["title"]}" appears to be a stub ({wiki["word_count"]} words). Classifying anyway.')
    if pre["is_list"]:
        warn(f'"{wiki["title"]}" appears to be a list article. Classifying anyway.')

    # Step 3: Build prompt
    log("Building classification prompt...", SILVER)
    system, user = build_prompt(wiki["title"], wiki["text"], wiki["outbound_links"])
    token_estimate = (len(system) + len(user)) // 4
    dim(f"Estimated prompt tokens: ~{token_estimate:,}")

    # Step 4: Classify
    log("Classifying...", SILVER)
    start = time.time()
    try:
        raw = call_api(system, user)
    except Exception as e:
        err(str(e))
        sys.exit(1)
    elapsed = time.time() - start
    ok(f"API responded in {elapsed:.1f}s")

    # Step 5: Parse
    log("Parsing response...", SILVER)
    try:
        parsed = parse_response(raw)
    except Exception as e:
        err(f"Failed to parse response: {e}")
        LAST_RESP_PATH.write_text(raw, encoding="utf-8")
        dim("Raw response saved to last_response.txt")
        sys.exit(1)
    ok("Response parsed and validated")

    # Step 6: Extract updates
    node, frontier_updates, all_edges = extract_graph_updates(
        wiki["title"], parsed, wiki["outbound_links"]
    )

    inferred_edges = [e for e in all_edges if e["source"] == "ai_inference"]
    structural_edges = [e for e in all_edges if e["source"] == "wikipedia_links"]

    # Step 7: Save curriculum separately
    CURRICULA_DIR.mkdir(exist_ok=True)
    safe_name = re.sub(r"[^a-z0-9]", "_", wiki["title"], flags=re.I)
    curriculum_path = CURRICULA_DIR / f"{safe_name}.json"
    curriculum_path.write_text(json.dumps({
        "title":        wiki["title"],
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "curriculum":   parsed["curriculum"],
        "triples":      parsed["triples"],
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    ok(f"Curriculum saved: curricula/{safe_name}.json")

    # Step 8: Update graph
    graph["nodes"][wiki["title"]] = node

    for f in frontier_updates:
        if f["id"] not in graph["nodes"] and f["id"] not in graph["frontier"]:
            graph["frontier"][f["id"]] = f

    existing_edge_keys = {
        (e["from"], e["to"], e["type"]) for e in graph["edges"]
    }
    for e in all_edges:
        key = (e["from"], e["to"], e["type"])
        if key not in existing_edge_keys:
            graph["edges"].append(e)
            existing_edge_keys.add(key)

    graph["meta"]["total_runs"] = graph["meta"].get("total_runs", 0) + 1
    graph["meta"]["last_run"] = datetime.now(timezone.utc).isoformat()

    save_graph(graph)
    ok("Graph saved to graph.json")

    # Step 8b: Persist to PostgreSQL
    conn = get_db_conn()
    if conn:
        try:
            db_write_node(conn, node)
            db_write_edges(conn, all_edges)
            db_write_frontier(conn, frontier_updates)
            db_write_curriculum(conn, wiki["title"], parsed["curriculum"])
            db_emit_event(conn, "node_classified", wiki["title"], {
                "node":           node,
                "edge_count":     len(all_edges),
                "inferred_count": len(inferred_edges),
            })
            conn.commit()
            ok("Written to PostgreSQL")
        except Exception as e:
            err(f"PostgreSQL write failed: {e}")
            conn.rollback()
        finally:
            conn.close()

    # Step 9: Display
    print_node(node)
    print_summary(graph, node, structural_edges, inferred_edges, frontier_updates)

    # Step 10: Suggest next nodes (from inferred edges - these are the meaningful ones)
    if inferred_edges:
        log("Suggested next articles to classify:", CYAN)
        for e in inferred_edges[:5]:
            dim(f'python pipeline.py "{e["to"]}"   ({e["predicate"]})')
        print()

# --- Random article ---
def fetch_random_title() -> str:
    resp = requests.get(
        "https://en.wikipedia.org/w/api.php",
        params={"action": "query", "list": "random", "rnnamespace": 0, "rnlimit": 1, "format": "json"}, headers={"User-Agent": "WikiFold/0.1 (learning graph project)"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["query"]["random"][0]["title"]

# --- Entry point ---
if __name__ == "__main__":
    args = sys.argv[1:]

    if "--random" in args or "-r" in args:
        log("Fetching a random Wikipedia article...", SILVER)
        try:
            random_title = fetch_random_title()
        except Exception as e:
            err(f"Failed to fetch random article: {e}")
            sys.exit(1)
        log(f"  Seed: {random_title}", GOLD)
        run(random_title)

    elif args:
        run(" ".join(args))

    else:
        print()
        log("╔══════════════════════════════════════════╗", GOLD)
        log("║          WikiFold Pipeline v0.1          ║", GOLD)
        log("╚══════════════════════════════════════════╝", GOLD)
        print()
        log("  Options:", SILVER)
        dim('python pipeline.py "Article Title"   classify a specific article')
        dim("python pipeline.py --random           classify a random article (your seed)")
        dim("python pipeline.py                    interactive prompt")
        print()
        title = input(f"{GOLD}  Article title (or press Enter for random): {RESET}").strip()
        if not title:
            log("Fetching a random Wikipedia article...", SILVER)
            try:
                title = fetch_random_title()
            except Exception as e:
                err(f"Failed to fetch random article: {e}")
                sys.exit(1)
            log(f"  Seed: {title}", GOLD)
        run(title)
