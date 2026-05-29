#!/usr/bin/env python3
"""
WikiFold - Classification Pipeline
Usage:  python pipeline.py "French Revolution"
        python pipeline.py --random
        python pipeline.py --worker           (drain frontier queue, batch of 5)
        python pipeline.py --worker --batch=10
        python pipeline.py                    (interactive)

Requires: pip install requests python-dotenv psycopg2-binary
Optional: pip install sentence-transformers numpy  (enables semantic similarity edges)
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

# Optional DB import
try:
    import psycopg2
    from psycopg2.extras import Json as PgJson
    PG_AVAILABLE = True
except ImportError:
    PG_AVAILABLE = False

# Optional embedding imports (lazy-loaded on first use)
_embed_model  = None
_EMBED_CHECKED = False

def _get_embed_model():
    """Lazy-load sentence-transformers on first call. Returns model or None."""
    global _embed_model, _EMBED_CHECKED
    if _EMBED_CHECKED:
        return _embed_model
    _EMBED_CHECKED = True
    try:
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
        ok("Embedding model loaded: all-MiniLM-L6-v2 (384-dim)")
    except Exception as e:
        warn(f"sentence-transformers not available — semantic edges disabled. ({e})")
        _embed_model = None
    return _embed_model

# --- Setup ---
BASE_DIR       = Path(__file__).parent
GRAPH_PATH     = BASE_DIR / "graph.json"
CURRICULA_DIR  = BASE_DIR / "curricula"
LAST_RESP_PATH = BASE_DIR / "last_response.txt"

load_dotenv(BASE_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost/wikifold")

# --- Colors ---
RESET  = "\033[0m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
GOLD   = "\033[33m"
CYAN   = "\033[36m"
GREEN  = "\033[32m"
RED    = "\033[31m"
SILVER = "\033[37m"

def log(msg, color=SILVER): print(f"{color}{msg}{RESET}")
def ok(msg):                 print(f"{GREEN}  + {msg}{RESET}")
def warn(msg):               print(f"{GOLD}  ! {msg}{RESET}")
def err(msg):                print(f"{RED}  x {msg}{RESET}")
def dim(msg):                print(f"{DIM}    {msg}{RESET}")

# --- DB helpers ---
def get_db_conn():
    if not PG_AVAILABLE:
        return None
    try:
        return psycopg2.connect(DATABASE_URL)
    except Exception as e:
        warn(f"DB connection failed: {e}. Writing graph.json only.")
        return None

def ensure_embeddings_table(conn):
    if conn is None:
        return
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS embeddings (
            node_id    TEXT PRIMARY KEY,
            vector     JSONB NOT NULL,
            model_name TEXT DEFAULT 'all-MiniLM-L6-v2',
            generated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    cur.close()

def db_write_node(conn, node: dict):
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
            nav_style_signal, gap_assessment, thumbnail_url, classified_at, visit_count
        ) VALUES (
            %s,%s,%s,%s, %s,%s,%s, %s,%s, %s,%s,%s,%s,
            %s,%s,%s, %s,%s, %s,%s,%s,%s, 1
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
            thumbnail_url       = COALESCE(EXCLUDED.thumbnail_url, nodes.thumbnail_url),
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
        node.get("thumbnail_url"),
        node.get("visited_at"),
    ))
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

def db_write_embedding(conn, node_id: str, vector: list):
    if conn is None or not vector:
        return
    ensure_embeddings_table(conn)
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO embeddings (node_id, vector, model_name, generated_at)
        VALUES (%s, %s, 'all-MiniLM-L6-v2', NOW())
        ON CONFLICT (node_id) DO UPDATE SET
            vector       = EXCLUDED.vector,
            model_name   = EXCLUDED.model_name,
            generated_at = NOW()
    """, (node_id, PgJson(vector)))
    cur.close()

def find_semantic_neighbors(conn, title: str, vector: list, top_k: int = 5, threshold: float = 0.72) -> list:
    """
    Load all stored embeddings and return top-K most similar nodes
    (cosine similarity, numpy). Returns list of (node_id, similarity_score).
    """
    if conn is None or not vector:
        return []
    try:
        import numpy as np
    except ImportError:
        return []

    try:
        ensure_embeddings_table(conn)
        cur = conn.cursor()
        cur.execute("SELECT node_id, vector FROM embeddings WHERE node_id != %s", (title,))
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        warn(f"Embedding lookup failed: {e}")
        return []

    if not rows:
        return []

    q = np.array(vector, dtype=np.float32)
    q_norm = float(np.linalg.norm(q))
    if q_norm < 1e-9:
        return []

    results = []
    for node_id, stored in rows:
        if stored is None:
            continue
        stored_list = stored if isinstance(stored, list) else list(stored)
        v = np.array(stored_list, dtype=np.float32)
        v_norm = float(np.linalg.norm(v))
        if v_norm < 1e-9:
            continue
        sim = float(np.dot(q, v) / (q_norm * v_norm))
        if sim >= threshold:
            results.append((node_id, round(sim, 4)))

    results.sort(key=lambda x: -x[1])
    return results[:top_k]

def generate_embedding(node: dict) -> list | None:
    """Generate a semantic embedding from node metadata text."""
    model = _get_embed_model()
    if model is None:
        return None
    parts = [node.get("title") or ""]
    if node.get("curiosity_hook"):
        parts.append(node["curiosity_hook"])
    if node.get("primary_domain"):
        parts.append(f"Domain: {node['primary_domain']}")
    if node.get("related_concepts"):
        parts.append("Related: " + ", ".join(node["related_concepts"][:8]))
    if node.get("gap_assessment"):
        parts.append(node["gap_assessment"][:200])
    text = ". ".join(p for p in parts if p)
    try:
        vec = model.encode(text)
        return vec.tolist()
    except Exception as e:
        warn(f"Embedding generation failed: {e}")
        return None

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

# --- Images ---
def fetch_best_thumbnail(title: str, headers: dict) -> str | None:
    """Try multiple sources for the best image for a Wikipedia article.

    Priority order:
      1. Wikipedia pageimages API (already in fetch_wikipedia, passed in)
      2. Wikimedia REST summary endpoint (different cache, often works when API is slow)
      3. Wikidata P18 image property (covers many entities with no Wikipedia thumbnail)
    """
    import urllib.parse as _ul

    # Source 2: Wikimedia REST summary (lightweight, different rate limit pool)
    try:
        encoded = _ul.quote(title.replace(" ", "_"), safe="")
        resp = requests.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}",
            headers=headers, timeout=8
        )
        if resp.status_code == 200:
            thumb = resp.json().get("thumbnail", {}).get("source")
            if thumb:
                return thumb
    except Exception:
        pass

    # Source 3: Wikidata P18 image property
    # Step 3a: resolve Wikipedia title to Wikidata QID via Wikipedia API
    try:
        wd_resp = requests.get(
            "https://en.wikipedia.org/w/api.php",
            params={"action": "query", "titles": title, "prop": "pageprops",
                    "ppprop": "wikibase_item", "redirects": 1,
                    "format": "json", "origin": "*"},
            headers=headers, timeout=8
        )
        if wd_resp.status_code == 200:
            pages = list(wd_resp.json().get("query", {}).get("pages", {}).values())
            qid = pages[0].get("pageprops", {}).get("wikibase_item") if pages else None
            if qid:
                # Step 3b: fetch Wikidata entity JSON and extract P18 (image filename)
                ent_resp = requests.get(
                    f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json",
                    headers=headers, timeout=8
                )
                if ent_resp.status_code == 200:
                    ent = ent_resp.json().get("entities", {}).get(qid, {})
                    claims = ent.get("claims", {})
                    p18 = claims.get("P18", [])
                    if p18:
                        filename = p18[0]["mainsnak"]["datavalue"]["value"]
                        encoded_fn = _ul.quote(filename.replace(" ", "_"), safe="")
                        # Wikimedia Commons thumbnail URL formula
                        return f"https://commons.wikimedia.org/wiki/Special:FilePath/{encoded_fn}?width=300"
    except Exception:
        pass

    return None

# --- Wikipedia ---
def verify_wiki_title(title: str):
    """Check if a Wikipedia article exists. Returns canonical title string or None."""
    base = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query", "titles": title,
        "redirects": 1, "format": "json", "origin": "*"
    }
    try:
        resp = requests.get(base, params=params,
                            headers={"User-Agent": "WikiFold/0.1 (learning graph project)"},
                            timeout=8)
        resp.raise_for_status()
        pages = resp.json().get("query", {}).get("pages", {})
        for pid, page in pages.items():
            if pid == "-1" or "missing" in page:
                return None
            return page.get("title", title)
    except Exception:
        return None

def fetch_wikipedia(title: str) -> dict:
    base = "https://en.wikipedia.org/w/api.php"
    params_text = {
        "action": "query", "titles": title,
        "prop": "extracts|pageimages", "exintro": False,
        "explaintext": True, "redirects": 1,
        "pithumbsize": 300, "piprop": "thumbnail",
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

    truncated = article_text[:10000] + "\n[article truncated]" \
        if len(article_text) > 10000 else article_text

    outbound_links = [l["title"] for l in links_pages[0].get("links", [])]
    word_count = len(article_text.split())

    thumbnail_url = page.get("thumbnail", {}).get("source") or None
    # Fallback: try Wikimedia REST + Wikidata if pageimages returned nothing
    if not thumbnail_url:
        headers = {"User-Agent": "WikiFold/0.1 (learning graph project)"}
        thumbnail_url = fetch_best_thumbnail(page["title"], headers)

    return {
        "title":          page["title"],
        "text":           truncated,
        "outbound_links": outbound_links,
        "word_count":     word_count,
        "thumbnail_url":  thumbnail_url,
    }

# --- Preclassifier ---
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
        "You never hallucinate facts. Every claim must be supportable from the article text. "
        "If the article does not contain enough information to answer a field confidently, "
        "use null rather than guessing."
    )

    user = f"""Analyze this Wikipedia article and return a single JSON object with three top-level keys: "classification", "triples", and "curriculum".

ARTICLE TITLE: {title}

OUTBOUND LINKS (articles this article links to):
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
    "curiosity_hook": "One sentence. The single most interesting, surprising, or strange fact about this subject. Write it as a fact, not a tease.",
    "primary_domain": "Single string. Choose from: mathematics, physics, chemistry, biology, medicine, psychology, philosophy, linguistics, history, politics, economics, law, technology, computing, engineering, art, literature, music, film, religion, mythology, geography, anthropology, sociology, sports, food, other",
    "domains": ["Array of all applicable domains from the list above"],
    "era": "ancient | medieval | early_modern | modern | contemporary | timeless",
    "primary_geography": "Single most relevant country or region, or null",
    "geography": ["Array of all relevant countries or regions"],
    "key_figures": ["Names of people central to this article"],
    "linguistic_root": "Etymological origin of the subject name, or null. Example: Greek: arithmos, meaning number",
    "related_concepts": ["3 to 6 concepts closely related to this subject that may not be directly linked"],
    "disambiguation_risks": ["Terms or concepts this subject is commonly confused with"],
    "nav_style_signal": "conceptual | biographical | geographical | chronological",
    "gap_assessment": "One paragraph describing what important context or information is absent from this Wikipedia article. Null if comprehensive."
  }},

  "triples": [
    {{
      "subject": "The article subject",
      "predicate": "Choose from the predicate vocabulary below",
      "object": "The target entity or concept",
      "object_is_link": true,
      "object_wiki_title": "Exact Wikipedia article title if object_is_link is true, else null",
      "source_sentence": "The sentence from the article that supports this triple, or null if drawing on widely-known background knowledge",
      "edge_type": "interpersonal | geographical | temporal | categorical | etymological | positional | implication | misconception | analogy | influence | application"
    }}
  ],

  "curriculum": {{
    "summary": "2 to 3 sentence overview suitable for a student encountering this for the first time",
    "gaps": ["Important concepts MISSING from the Wikipedia article that a student would need. Empty array if none."],
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
- article_type: "canonical" if depth_score >= 7 and substantial content. "curiosity" if depth_score 4-6 or weird_factor >= 7. "stub" if very short. "list" if primarily a list.
- depth_score: 0-10. Conceptual richness, sourcing quality, educational value.
- shareability_score: 0-10. How likely someone is to share this.
- weird_factor: 0-10. How surprising or counterintuitive the subject is.
- curiosity_hook: Must be a genuine fact. Bad: "This covers an important event." Good: "The Great Molasses Flood of 1919 moved at 35 mph, killing 21 people."
- nav_style_signal: How would most people navigate away?
- era: Use "timeless" for mathematics, logic, natural laws.

RULES FOR triples:
- Extract 12 to 28 triples. Be thorough and think like a domain expert who knows this subject well.
- source_sentence: copy the exact supporting sentence from the article text. If the relationship is common knowledge widely confirmed by Wikipedia but not stated in this excerpt, you may use null -- but this must be genuinely verifiable, not speculative.
- object_wiki_title should be the exact Wikipedia article title for the object entity. Set it for ANY entity that plausibly has a Wikipedia article -- you are NOT limited to the outbound links list above. The outbound links are a hint, not a ceiling.
- object_is_link should be true whenever you set object_wiki_title. Set it false only for abstract concepts that have no Wikipedia article (e.g. "the idea of justice", "an unnamed ancestor").
- Never emit a triple where subject and object are the same article.
- AIM TO USE EVERY EDGE TYPE FAMILY. Push yourself to find temporal, implication, analogy, influence, and application edges, not just categorical and geographical ones.

THINK LIKE A DOMAIN EXPERT -- for every article, consider:
- RIVALS & CONTEMPORARIES: What competed with this? What else existed at the same time? (analogy: "is analogous to", temporal: "contemporaneous with")
- CHARACTERS & KEY FIGURES: Who are the most iconic people/characters associated with this? (positional: "stars", "depicts")
- REAL-WORLD IMPACT: What did this cause, inspire, or regulate? What laws, organizations, or movements resulted from this? (implication: "historically led to", influence: "gave rise to")
- ADAPTATIONS & SPIN-OFFS: Was this adapted into films, games, books, sequels? (positional: "created", influence: "gave rise to")
- CREATORS & PUBLISHERS: Who made it? Who funded it? Who distributed it? (interpersonal: "created", positional: "founded")
- PLATFORM & MEDIUM: What platform, genre, or medium does this belong to? (categorical: "type of", "part of")
- PREDECESSOR & SUCCESSOR: What came before and after? (temporal: "preceded by", "succeeded by")
- CONTROVERSIES & MISCONCEPTIONS: What is this commonly confused with? What challenged it? (misconception, implication: "challenged by")

Examples of the kind of rich connections to extract:
- For a VIDEO GAME: the game's franchise predecessors, rival franchises (Street Fighter vs Mortal Kombat), iconic characters (Sub-Zero for MK), the rating board it helped create (ESRB), the studio that made it, film adaptations, the genre it defines.
- For a SCIENTIST: their major discoveries, rival theories, the institutions they led, the students they mentored, the era they worked in.
- For a HISTORICAL EVENT: what caused it, what it resulted in, parallel events elsewhere, key figures involved, the era it occurred in.
- For a SPECIES: its genus, its habitat, what predates it, what it competes with, conservation status organizations.

- Use ONLY these predicates:

  INTERPERSONAL: married to, parent of, child of, sibling of, allied with, opposed by, mentored, mentored by, collaborated with, succeeded by, preceded by as leader
  POSITIONAL: served as, founded, led, member of, employed by, created, invented, authored, directed, plays, plays as, competes in, written in, set in, stars, depicts
  GEOGRAPHICAL: born in, died in, located in, originated in, conquered, invaded, capital of, broadcast in
  TEMPORAL: occurred during, caused by, resulted in, contemporaneous with, preceded by, succeeded by
  CATEGORICAL: type of, subfield of, instance of, part of, used in, plays in, produces, competes in, depicts
  ETYMOLOGICAL: derived from, root meaning, synonym of, antonym of, also known as
  IMPLICATION: implies, is prerequisite for, enables, contradicts, historically led to, challenged by
  MISCONCEPTION: commonly confused with, often mistaken for, is not the same as, was historically misattributed to
  ANALOGY: is analogous to, parallels, is the equivalent of in
  INFLUENCE: influenced, was inspired by, gave rise to, is a precursor of, shaped the development of
  APPLICATION: is applied in, enables the study of, has applications in, underlies, is used to solve

- edge_type must match the predicate family above.
- Do not duplicate triples.

CRITICAL predicate rules — these are the most common errors:

PEOPLE / PERSONS:
- A PERSON is never "type of" a sport, discipline, or role. Use POSITIONAL instead.
  WRONG: {{ "subject": "Paolo DelPiccolo", "predicate": "type of", "object": "Association football" }}
  RIGHT: {{ "subject": "Paolo DelPiccolo", "predicate": "plays", "object": "Association football", "edge_type": "positional" }}
- A PERSON is never "type of" a profession. Use POSITIONAL "served as".
  WRONG: {{ "subject": "James Gilreath", "predicate": "type of", "object": "Songwriter" }}
  RIGHT: {{ "subject": "James Gilreath", "predicate": "served as", "object": "Songwriter", "edge_type": "positional" }}
- INTERPERSONAL predicates (parent of, mentored, collaborated with) are for people-to-people relationships only.

FILMS / MEDIA:
- A FILM is never "employed by" a setting, theme, or subject. Use POSITIONAL or CATEGORICAL.
  WRONG: {{ "subject": "American Visa", "predicate": "employed by", "object": "Strip club" }}
  RIGHT: {{ "subject": "American Visa", "predicate": "set in", "object": "Strip club", "edge_type": "positional" }}
- A FILM is never "type of" a person or profession depicted in it.
  WRONG: {{ "subject": "American Visa", "predicate": "type of", "object": "Exotic dancer" }}
  RIGHT: {{ "subject": "American Visa", "predicate": "depicts", "object": "Exotic dancer", "edge_type": "categorical" }}

SPORTS CLUBS:
- A SPORTS CLUB is never "type of" a sport. Use CATEGORICAL "competes in".
  WRONG: {{ "subject": "G.D. Chaves", "predicate": "type of", "object": "Association football" }}
  RIGHT: {{ "subject": "G.D. Chaves", "predicate": "competes in", "object": "Association football", "edge_type": "categorical" }}

PUBLICATIONS:
- A PUBLICATION is never "type of" a language. Use POSITIONAL "written in".

ONTOLOGY:
- "type of" means strict ontological classification: Epidendrum is type of Orchid. Beetle is type of Insect.
- Do NOT use "type of" for roles, participation, settings, or depicted subjects.

MENTORSHIP DIRECTION:
- "mentored" means the subject taught the object.
  RIGHT: {{ "subject": "Pamphilus of Caesarea", "predicate": "mentored", "object": "Eusebius of Caesarea" }}
- "mentored by" means the subject was taught by the object.

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
            "anthropic-version": "2023-06-01",
            "content-type":      "application/json",
        },
        json={
            "model":      MODEL,
            "max_tokens": 8000,
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

    valid_types_edge = {
        "interpersonal", "geographical", "temporal", "categorical",
        "etymological", "positional", "implication", "misconception",
        "analogy", "influence", "application"
    }
    if not isinstance(parsed["triples"], list):
        parsed["triples"] = []

    parsed["triples"] = [
        t for t in parsed["triples"]
        if t.get("subject") and t.get("predicate") and t.get("object") and t.get("source_sentence")
    ]

    for t in parsed["triples"]:
        if t.get("edge_type") not in valid_types_edge:
            t["edge_type"] = "categorical"

    if parsed["curriculum"].get("quiz"):
        for q in parsed["curriculum"]["quiz"]:
            if not isinstance(q.get("tier"), int):
                q["tier"] = 1
            q["tier"] = max(0, min(2, q["tier"]))

    return parsed

# --- Graph updates ---
def extract_graph_updates(title: str, parsed: dict, outbound_links: list, thumbnail_url: str = None) -> tuple:
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
        "thumbnail_url":       thumbnail_url,
        "visited_at":          now,
    }

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

    # Build typed edges from LLM triples.
    # Triple targets may be any Wikipedia article -- not limited to outbound links.
    # For targets already in outbound_links we trust them directly.
    # For novel targets we verify existence via the Wikipedia API before creating the edge.
    outbound_set = set(outbound_links)
    inferred_edges = []
    for t in triples:
        raw_target = t.get("object_wiki_title")
        if not raw_target or not t.get("object_is_link"):
            continue
        raw_target = raw_target.strip()
        if raw_target == title:
            continue
        if raw_target in outbound_set:
            canonical = raw_target
        else:
            # Verify the article exists on Wikipedia; get canonical title
            canonical = verify_wiki_title(raw_target)
            if not canonical:
                continue
        inferred_edges.append({
            "from":            title,
            "to":              canonical,
            "type":            t.get("edge_type", "categorical"),
            "predicate":       t.get("predicate", "related to"),
            "weight":          0.8,
            "source":          "ai_inference",
            "source_sentence": t.get("source_sentence", ""),
            "created_at":      now,
        })

    # Queue all typed-edge targets as frontier nodes (they are meaningful relationships)
    inferred_targets = {e["to"] for e in inferred_edges}
    frontier_updates = [
        {"id": link, "title": link, "classified": False, "linked_from": title}
        for link in inferred_targets if link != title
    ]

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

def print_summary(graph: dict, node: dict, structural_edges: list, inferred_edges: list, frontier_updates: list, semantic_edges: list):
    new_frontier = sum(1 for f in frontier_updates if f["id"] not in graph["nodes"])
    log("─" * 60, DIM)
    ok(f"Node classified:   {node['title']}")
    ok(f"Structural edges:  {len(structural_edges)}")
    ok(f"Inferred edges:    {len(inferred_edges)}  (AI typed relationships)")
    ok(f"Semantic edges:    {len(semantic_edges)}  (embedding similarity)")
    ok(f"Frontier added:    {new_frontier}")
    ok(f"Total nodes:       {len(graph['nodes'])}")
    ok(f"Total edges:       {len(graph['edges'])}")
    ok(f"Total frontier:    {len(graph['frontier'])}")
    log("─" * 60, DIM)

# --- Cross-node edge inference ---

CROSS_EDGE_PREDICATES = """
  INTERPERSONAL: married to, parent of, child of, sibling of, allied with, opposed by, mentored, mentored by, collaborated with, succeeded by, preceded by as leader
  POSITIONAL: served as, founded, led, member of, employed by, created, invented, authored, directed, plays, competes in, written in, set in, depicts
  GEOGRAPHICAL: born in, died in, located in, originated in, conquered, invaded, capital of
  TEMPORAL: occurred during, caused by, resulted in, contemporaneous with, preceded by, succeeded by
  CATEGORICAL: type of, subfield of, instance of, part of, used in, produces, competes in
  ETYMOLOGICAL: derived from, synonym of, also known as
  IMPLICATION: implies, is prerequisite for, enables, contradicts, historically led to, challenged by
  MISCONCEPTION: commonly confused with, often mistaken for, is not the same as
  ANALOGY: is analogous to, parallels, is the equivalent of in
  INFLUENCE: influenced, was inspired by, gave rise to, is a precursor of, shaped the development of
  APPLICATION: is applied in, enables the study of, has applications in, underlies, is used to solve
"""

def build_cross_edges_prompt(new_title: str, new_text: str, existing_nodes: list) -> tuple:
    node_lines = []
    for n in existing_nodes[:50]:
        hook = n.get("curiosity_hook") or ""
        hook_str = (" | " + hook[:120]) if hook else ""
        node_lines.append(f"  - {n['id']} ({n.get('primary_domain','?')}, {n.get('article_type','?')}){hook_str}")
    node_list = "\n".join(node_lines)

    system = (
        "You are WikiFold's cross-reference engine. You find meaningful semantic relationships between "
        "Wikipedia articles that a knowledgeable person would recognize as real. "
        "You never hallucinate. Return only valid JSON with no markdown or preamble."
    )

    user = f"""We just classified the article "{new_title}".

Here is an excerpt from its Wikipedia article:
---
{new_text[:3000]}
---

Here are {len(existing_nodes)} other articles already in our knowledge graph:
{node_list}

Find any GENUINE relationships between "{new_title}" and the listed articles.
Only include relationships that are factually grounded and specific.
Think broadly: geographical proximity, shared time periods, shared domain, causal links,
analogies, mutual influence, shared people, shared themes.

Return JSON exactly:
{{
  "cross_edges": [
    {{
      "from": "{new_title}",
      "to": "exact title from the list above",
      "predicate": "one predicate from the vocabulary",
      "edge_type": "interpersonal | geographical | temporal | categorical | etymological | positional | implication | misconception | analogy | influence | application",
      "reasoning": "one sentence factual justification"
    }}
  ]
}}

Predicate vocabulary:
{CROSS_EDGE_PREDICATES}

Rules:
- "to" must be the exact title from the list above.
- Never force a connection. If no genuine relationship exists, return {{"cross_edges": []}}.
- Maximum 10 cross-edges.
- Do not add edges between articles with no meaningful connection beyond both existing in Wikipedia."""

    return system, user


def generate_cross_edges(title: str, text: str, conn) -> list:
    """Query existing classified nodes and ask the LLM to find cross-edges."""
    if conn is None:
        return []
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT id, primary_domain, article_type, curiosity_hook
            FROM nodes
            WHERE classified = true AND id != %s
            ORDER BY classified_at DESC
            LIMIT 60
        """, (title,))
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        warn(f"Cross-edge query failed: {e}")
        return []

    if not rows:
        return []

    existing = [
        {"id": r[0], "primary_domain": r[1], "article_type": r[2], "curiosity_hook": r[3]}
        for r in rows
    ]

    log(f"  Running cross-node inference against {len(existing)} existing nodes...", SILVER)

    system, user = build_cross_edges_prompt(title, text, existing)
    try:
        raw = call_api(system, user)
    except Exception as e:
        warn(f"  Cross-edge API call failed: {e}")
        return []

    try:
        cleaned = re.sub(r"^```json\s*", "", raw, flags=re.I)
        cleaned = re.sub(r"^```\s*", "", cleaned)
        cleaned = re.sub(r"```\s*$", "", cleaned).strip()
        data = json.loads(cleaned)
        cross = data.get("cross_edges", [])
    except Exception as e:
        warn(f"  Cross-edge parse failed: {e}")
        return []

    valid_edge_types = {
        "interpersonal", "geographical", "temporal", "categorical",
        "etymological", "positional", "implication", "misconception",
        "analogy", "influence", "application",
    }
    valid_ids = {n["id"] for n in existing}
    now = datetime.now(timezone.utc).isoformat()

    edges = []
    for ce in cross:
        if not isinstance(ce, dict):
            continue
        to = ce.get("to", "")
        predicate = ce.get("predicate", "")
        edge_type = ce.get("edge_type", "categorical")
        if not to or not predicate:
            continue
        if to not in valid_ids:
            continue
        if to == title:
            continue
        if edge_type not in valid_edge_types:
            edge_type = "categorical"
        edges.append({
            "from":            title,
            "to":              to,
            "type":            edge_type,
            "predicate":       predicate,
            "weight":          0.75,
            "source":          "ai_inference",
            "source_sentence": ce.get("reasoning", ""),
            "created_at":      now,
        })

    if edges:
        ok(f"  Cross-edges found: {len(edges)}")
        for e in edges:
            dim(f"    {e['from']} --[{e['predicate']}]--> {e['to']}")
    else:
        dim("  No cross-edges found.")

    return edges


# --- Repair: re-run cross-edge inference for all classified node pairs ---
def repair_cross_edges():
    """Re-run cross-edge inference for every classified node against all others."""
    log("Cross-edge repair: scanning all classified nodes...", GOLD)
    conn = get_db_conn()
    if conn is None:
        err("No DB connection.")
        return

    try:
        cur = conn.cursor()
        cur.execute("SELECT id, curiosity_hook FROM nodes WHERE classified = true ORDER BY classified_at DESC")
        all_nodes = cur.fetchall()
        cur.close()
    except Exception as e:
        err(f"Query failed: {e}")
        conn.close()
        return

    log(f"Found {len(all_nodes)} classified nodes. Checking each for cross-edges.", CYAN)
    total_added = 0

    for node_id, _ in all_nodes:
        log(f"\nProcessing: {node_id}", CYAN)
        # Fetch article text from Wikipedia for context
        try:
            wiki = fetch_wikipedia(node_id)
        except Exception as e:
            warn(f"  Wikipedia fetch failed: {e}")
            continue

        cross_edges = generate_cross_edges(node_id, wiki["text"], conn)
        if cross_edges:
            try:
                db_write_edges(conn, cross_edges)
                conn.commit()
                total_added += len(cross_edges)
            except Exception as e:
                warn(f"  Edge write failed: {e}")
                conn.rollback()

    conn.close()
    log(f"\nRepair complete: {total_added} cross-edges added across {len(all_nodes)} nodes.", GOLD)


# --- Seeding: add high-quality canonical articles to frontier ---
SEED_ARTICLES = [
    "French Revolution",
    "DNA",
    "Quantum mechanics",
    "Ancient Rome",
    "Evolution",
    "Philosophy",
    "Mathematics",
    "Democracy",
    "Renaissance",
    "World War II",
    "Albert Einstein",
    "Isaac Newton",
    "Ancient Greece",
    "Photosynthesis",
    "Black hole",
    "Capitalism",
    "Feudalism",
    "Silk Road",
    "Byzantine Empire",
    "Industrial Revolution",
    "Printing press",
    "Roman Republic",
    "Scientific Revolution",
    "The Enlightenment",
    "Charles Darwin",
    "Plato",
    "Aristotle",
    "Leonardo da Vinci",
    "Shakespeare",
    "Colonialism",
]

def backfill_images():
    """Fetch thumbnail_url for all classified nodes that currently have none.
    Tries Wikipedia REST, then Wikidata P18 as fallback."""
    conn = get_db_conn()
    if not conn:
        err("No DB connection for backfill-images")
        return
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM nodes WHERE classified = true AND (thumbnail_url IS NULL OR thumbnail_url = '')")
        rows = cur.fetchall()
        cur.close()
        log(f"Backfilling images for {len(rows)} nodes...", GOLD)
        headers = {"User-Agent": "WikiFold/0.1 (learning graph project)"}
        updated = 0
        for (node_id,) in rows:
            try:
                thumb = fetch_best_thumbnail(node_id, headers)
                if thumb:
                    c2 = conn.cursor()
                    c2.execute("UPDATE nodes SET thumbnail_url = %s WHERE id = %s", (thumb, node_id))
                    c2.close()
                    conn.commit()
                    ok(f"  {node_id}")
                    updated += 1
                else:
                    dim(f"  {node_id}: no image found")
                time.sleep(1.2)
            except Exception as e:
                warn(f"  {node_id}: {e}")
        log(f"Updated {updated}/{len(rows)} nodes with thumbnails.", GOLD)
    except Exception as e:
        err(f"backfill-images failed: {e}")
        conn.rollback()
    finally:
        conn.close()

def seed_frontier():
    """Add canonical high-quality articles to the frontier queue."""
    conn = get_db_conn()
    if conn is None:
        err("No DB connection.")
        return

    cur = conn.cursor()
    added = 0
    for title in SEED_ARTICLES:
        try:
            cur.execute(
                "INSERT INTO frontier (id, title, added_at) VALUES (%s, %s, NOW()) ON CONFLICT (id) DO NOTHING",
                (title, title)
            )
            if cur.rowcount:
                ok(f"  Queued: {title}")
                added += 1
            else:
                dim(f"  Already queued: {title}")
        except Exception as e:
            warn(f"  Failed to queue {title}: {e}")
    conn.commit()
    cur.close()
    conn.close()
    ok(f"\nSeeded {added} articles into the frontier queue.")


# --- Main pipeline ---
def run(input_title: str):
    print()
    log("+===========================================+", GOLD)
    log("|          WikiFold Pipeline v0.2          |", GOLD)
    log("+===========================================+", GOLD)
    print()

    graph = load_graph()

    if graph["nodes"].get(input_title, {}).get("classified"):
        warn(f'"{input_title}" is already in the graph.')
        dim("Delete the node from graph.json to reclassify.")
        print_node(graph["nodes"][input_title])
        return

    # Step 1: Fetch
    log(f'Fetching Wikipedia: "{input_title}"...', SILVER)
    try:
        wiki = fetch_wikipedia(input_title)
    except ValueError as e:
        # Permanent failure: article doesn't exist or is too short/stub —
        # exit code 2 so drain_frontier removes it from the queue rather than retrying
        err(str(e))
        sys.exit(2)
    except Exception as e:
        # Transient failure: network error, rate limit, etc — keep in queue for retry
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
    log("Classifying with LLM...", SILVER)
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

    # Step 6: Extract graph updates
    node, frontier_updates, all_edges = extract_graph_updates(
        wiki["title"], parsed, wiki["outbound_links"], wiki.get("thumbnail_url")
    )

    inferred_edges   = [e for e in all_edges if e["source"] == "ai_inference"]
    structural_edges = [e for e in all_edges if e["source"] == "wikipedia_links"]

    # Step 7: Save curriculum to disk
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

    # Step 8: Update graph.json
    graph["nodes"][wiki["title"]] = node

    for f in frontier_updates:
        if f["id"] not in graph["nodes"] and f["id"] not in graph["frontier"]:
            graph["frontier"][f["id"]] = f

    existing_edge_keys = {(e["from"], e["to"], e["type"]) for e in graph["edges"]}
    for e in all_edges:
        key = (e["from"], e["to"], e["type"])
        if key not in existing_edge_keys:
            graph["edges"].append(e)
            existing_edge_keys.add(key)

    graph["meta"]["total_runs"] = graph["meta"].get("total_runs", 0) + 1
    graph["meta"]["last_run"] = datetime.now(timezone.utc).isoformat()

    save_graph(graph)
    ok("Graph saved to graph.json")

    # Step 9: Persist to PostgreSQL
    semantic_edges = []
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

            # Step 10: Embedding + semantic edges
            log("Generating embedding...", SILVER)
            vec = generate_embedding(node)
            if vec:
                ok(f"Embedding generated ({len(vec)}-dim)")
                db_write_embedding(conn, wiki["title"], vec)

                neighbors = find_semantic_neighbors(conn, wiki["title"], vec)
                if neighbors:
                    now = datetime.now(timezone.utc).isoformat()
                    for neighbor_id, sim_score in neighbors:
                        se = {
                            "from":            wiki["title"],
                            "to":              neighbor_id,
                            "type":            "semantic",
                            "predicate":       "semantically similar to",
                            "weight":          sim_score,
                            "source":          "embedding_similarity",
                            "source_sentence": f"Cosine similarity: {sim_score:.3f}",
                            "created_at":      now,
                        }
                        semantic_edges.append(se)
                    db_write_edges(conn, semantic_edges)
                    # Add to graph.json
                    for e in semantic_edges:
                        key = (e["from"], e["to"], e["type"])
                        if key not in existing_edge_keys:
                            graph["edges"].append(e)
                            existing_edge_keys.add(key)
                    save_graph(graph)
                    ok(f"Semantic edges: {len(semantic_edges)} neighbors found (threshold 0.72)")

                conn.commit()
            else:
                warn("Embedding skipped (sentence-transformers not installed)")

            # Step 10b: Cross-node edge inference
            log("Generating cross-node edges...", SILVER)
            conn2 = get_db_conn()
            if conn2:
                try:
                    cross_edges = generate_cross_edges(wiki["title"], wiki["text"], conn2)
                    if cross_edges:
                        db_write_edges(conn2, cross_edges)
                        conn2.commit()
                        # Also add to graph.json
                        for e in cross_edges:
                            key = (e["from"], e["to"], e["type"])
                            if key not in existing_edge_keys:
                                graph["edges"].append(e)
                                existing_edge_keys.add(key)
                        save_graph(graph)
                except Exception as e:
                    warn(f"Cross-edge step failed: {e}")
                    conn2.rollback()
                finally:
                    conn2.close()

        except Exception as e:
            err(f"PostgreSQL write failed: {e}")
            conn.rollback()
        finally:
            conn.close()

    # Step 11: Display
    print_node(node)
    print_summary(graph, node, structural_edges, inferred_edges, frontier_updates, semantic_edges)

    if inferred_edges:
        log("Suggested next articles to classify:", CYAN)
        for e in inferred_edges[:5]:
            dim(f'python pipeline.py "{e["to"]}"   ({e["predicate"]})')
        print()

# --- Frontier drain worker ---
def drain_frontier(batch_size: int = 5):
    """Process unclassified items from the frontier queue."""
    log(f"Frontier worker: draining up to {batch_size} items...", GOLD)

    conn = get_db_conn()
    if conn is None:
        err("No DB connection. Cannot drain frontier.")
        sys.exit(1)

    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT f.id, f.title
            FROM frontier f
            LEFT JOIN nodes n ON n.id = f.id AND n.classified = true
            WHERE n.id IS NULL
            ORDER BY
              CASE WHEN f.linked_from IS NULL THEN 0 ELSE 1 END ASC,
              f.added_at DESC
            LIMIT %s
        """, (batch_size,))
        rows = cur.fetchall()
        cur.close()
    except Exception as e:
        err(f"Frontier query failed: {e}")
        conn.close()
        sys.exit(1)
    finally:
        conn.close()

    if not rows:
        log("Frontier queue is empty. Nothing to process.", SILVER)
        return

    log(f"Found {len(rows)} item(s) to classify:", CYAN)
    for _, title in rows:
        dim(f"  - {title}")
    print()

    succeeded = 0
    failed    = 0
    removed   = 0
    for i, (node_id, title) in enumerate(rows):
        log(f"[{i+1}/{len(rows)}] Processing: \"{title}\"", CYAN)
        try:
            run(title)
            succeeded += 1
        except SystemExit as e:
            if e.code == 2:
                # Permanent failure (article not found / too short) — remove from frontier
                try:
                    conn2 = get_db_conn()
                    if conn2:
                        c2 = conn2.cursor()
                        c2.execute("DELETE FROM frontier WHERE id = %s", (node_id,))
                        conn2.commit()
                        c2.close()
                        conn2.close()
                except Exception:
                    pass
                warn(f'  Removed "{title}" from frontier (article not found)')
                removed += 1
            elif e.code != 0:
                warn(f'  Skipped "{title}" (pipeline error {e.code})')
                failed += 1
        except Exception as e:
            err(f'  Failed "{title}": {e}')
            failed += 1

    print()
    log("=" * 50, GOLD)
    ok(f"Drain complete: {succeeded} classified, {failed} failed, {removed} removed (not found)")
    log("=" * 50, GOLD)

# --- Random article ---
def fetch_random_title() -> str:
    resp = requests.get(
        "https://en.wikipedia.org/w/api.php",
        params={"action": "query", "list": "random", "rnnamespace": 0, "rnlimit": 1, "format": "json"},
        headers={"User-Agent": "WikiFold/0.1 (learning graph project)"},
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["query"]["random"][0]["title"]

# --- API key check ---
API_KEY = os.getenv("LLM_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
MODEL   = os.getenv("MODEL", "claude-haiku-4-5-20251001")

if not API_KEY:
    print("\n  ERROR: LLM_API_KEY (or ANTHROPIC_API_KEY) not found in .env\n")
    sys.exit(1)

# --- Entry point ---
if __name__ == "__main__":
    args = sys.argv[1:]

    # Worker / drain mode
    if "--worker" in args or "--drain" in args:
        batch = 5
        for a in args:
            if a.startswith("--batch="):
                try:
                    batch = int(a.split("=")[1])
                except ValueError:
                    pass
        drain_frontier(batch)

    elif "--random" in args or "-r" in args:
        log("Fetching a random Wikipedia article...", SILVER)
        try:
            random_title = fetch_random_title()
        except Exception as e:
            err(f"Failed to fetch random article: {e}")
            sys.exit(1)
        log(f"  Seed: {random_title}", GOLD)
        run(random_title)

    elif "--repair-cross" in args:
        # Re-run cross-edge inference for all classified nodes
        repair_cross_edges()

    elif "--backfill-images" in args:
        # Fetch and store thumbnail_url for all classified nodes that lack one
        backfill_images()

    elif "--enrich" in args:
        # Re-classify one or more existing nodes with the current (improved) prompt.
        # New edges accumulate in DB (DO NOTHING on duplicates, new rows inserted).
        # Usage: python pipeline.py --enrich "Mortal Kombat"
        #        python pipeline.py --enrich "Mortal Kombat" "DNA" "French Revolution"
        enrich_titles = [a for a in args if not a.startswith("--")]
        if not enrich_titles:
            err("--enrich requires at least one article title.")
            err('Usage: python pipeline.py --enrich "Article Title"')
            sys.exit(1)
        for t in enrich_titles:
            log(f'Re-enriching: "{t}"', GOLD)
            run(t)

    elif "--reseed" in args:
        # Add canonical high-quality articles to the frontier
        log("Seeding frontier with canonical articles...", GOLD)
        seed_frontier()

    elif args:
        run(" ".join(args))

    else:
        print()
        log("+===========================================+", GOLD)
        log("|          WikiFold Pipeline v0.2          |", GOLD)
        log("+===========================================+", GOLD)
        print()
        log("  Options:", SILVER)
        dim('python pipeline.py "Article Title"       classify a specific article')
        dim("python pipeline.py --random               classify a random article")
        dim("python pipeline.py --worker               drain the frontier queue (batch 5)")
        dim("python pipeline.py --worker --batch=10    drain 10 items at a time")
        dim("python pipeline.py --reseed               add 30 canonical articles to the frontier")
        dim("python pipeline.py --repair-cross         re-run cross-edge inference for all nodes")
        dim("python pipeline.py --backfill-images      fetch thumbnails for nodes that have none")
        dim('python pipeline.py --enrich "Title"       re-classify node(s) with improved prompt')
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
