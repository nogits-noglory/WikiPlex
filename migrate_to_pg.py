#!/usr/bin/env python3
"""
Migrate graph.json + curricula/*.json into PostgreSQL.
Usage: python migrate_to_pg.py
Requires: pip install psycopg2-binary
"""
import json
import os
import re
import sys
from pathlib import Path
from datetime import timezone, datetime

import psycopg2
from psycopg2.extras import Json

BASE_DIR = Path(__file__).parent
GRAPH_PATH = BASE_DIR / "graph.json"
CURRICULA_DIR = BASE_DIR / "curricula"

DB_URL = os.getenv("DATABASE_URL", "postgresql://localhost/wikifold")


def main():
    print("WikiFold → PostgreSQL migration")
    print(f"Graph: {GRAPH_PATH}")
    print(f"DB:    {DB_URL}\n")

    graph = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    nodes = graph.get("nodes", {})
    edges = graph.get("edges", [])
    frontier = graph.get("frontier", {})

    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # ── Nodes ────────────────────────────────────────────────────
    node_count = 0
    for node_id, n in nodes.items():
        cur.execute("""
            INSERT INTO nodes (
                id, title, classified, article_type,
                depth_score, shareability_score, weird_factor,
                curriculum_worthy, curiosity_hook,
                primary_domain, domains, era, primary_geography,
                geography, key_figures, linguistic_root,
                related_concepts, disambiguation_risks,
                nav_style_signal, gap_assessment, classified_at
            ) VALUES (
                %s,%s,%s,%s, %s,%s,%s, %s,%s, %s,%s,%s,%s,
                %s,%s,%s, %s,%s, %s,%s,%s
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
                classified_at       = EXCLUDED.classified_at
        """, (
            node_id,
            n.get("title", node_id),
            n.get("classified", False),
            n.get("article_type"),
            n.get("depth_score"),
            n.get("shareability_score"),
            n.get("weird_factor"),
            n.get("curriculum_worthy"),
            n.get("curiosity_hook"),
            n.get("primary_domain"),
            Json(n["domains"]) if n.get("domains") else None,
            n.get("era"),
            n.get("primary_geography"),
            Json(n["geography"]) if n.get("geography") else None,
            Json(n["key_figures"]) if n.get("key_figures") else None,
            n.get("linguistic_root"),
            Json(n["related_concepts"]) if n.get("related_concepts") else None,
            Json(n["disambiguation_risks"]) if n.get("disambiguation_risks") else None,
            n.get("nav_style_signal"),
            n.get("gap_assessment"),
            n.get("visited_at") or n.get("classified_at"),
        ))
        node_count += 1

    print(f"  ✓ Nodes:    {node_count}")

    # ── Frontier ─────────────────────────────────────────────────
    frontier_count = 0
    for fid, f in frontier.items():
        if fid in nodes:
            continue  # already a classified node
        cur.execute("""
            INSERT INTO frontier (id, title, linked_from)
            VALUES (%s, %s, %s)
            ON CONFLICT (id) DO NOTHING
        """, (fid, f.get("title", fid), f.get("linked_from")))
        frontier_count += 1

    print(f"  ✓ Frontier: {frontier_count}")

    # ── Edges ─────────────────────────────────────────────────────
    edge_count = 0
    skip_count = 0
    for e in edges:
        try:
            cur.execute("""
                INSERT INTO edges (from_node, to_node, edge_type, predicate, weight, edge_source, source_sentence, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (from_node, to_node, edge_type, predicate) DO NOTHING
            """, (
                e["from"],
                e["to"],
                e.get("type", "structural"),
                e.get("predicate", "links to"),
                e.get("weight", 1.0),
                e.get("source", "wikipedia_links"),
                e.get("source_sentence"),
                e.get("created_at"),
            ))
            edge_count += 1
        except Exception as ex:
            skip_count += 1

    print(f"  ✓ Edges:    {edge_count} (skipped {skip_count})")

    # ── Curricula ─────────────────────────────────────────────────
    curr_count = 0
    if CURRICULA_DIR.exists():
        for f in CURRICULA_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                node_id = data.get("title")
                if not node_id:
                    continue
                cur.execute("""
                    INSERT INTO curricula (node_id, data, generated_at)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (node_id) DO UPDATE SET
                        data         = EXCLUDED.data,
                        generated_at = EXCLUDED.generated_at
                """, (node_id, Json(data), data.get("generated_at")))
                curr_count += 1
            except Exception as ex:
                print(f"  ! Curriculum {f.name}: {ex}")

    print(f"  ✓ Curricula: {curr_count}")

    conn.commit()
    cur.close()
    conn.close()

    print("\n  Migration complete.")


if __name__ == "__main__":
    main()
