# CHEATSHEET — the whole project as a flow

Every box below is a real thing in the repo. For each one: **what goes in, what comes out,
and why it exists.** Follow the arrows top to bottom.

[HANDBOOK.md](HANDBOOK.md) is the long version — read that when you need *why* a decision
was made. This is *what happens, in order*.

---

## The map

```
                        ┌──────────────────────────────────────────┐
                        │  A. TWO SOURCES                          │
                        │  Adzuna API        synthetic generator   │
                        └───────┬──────────────────────┬───────────┘
                                │  4,909 real          │  ~196k generated
                                └──────────┬───────────┘
                                           ▼
                                ┌────────────────────┐
                                │  B. RAW LANDING    │   *.jsonl on disk
                                │  never edited      │   205,000 rows
                                └─────────┬──────────┘
                                          ▼
                                ┌────────────────────┐
                                │  C. PySpark ETL    │   clean · dedupe · skills
                                └─────────┬──────────┘
                                          ▼
                                ┌────────────────────┐
                                │  D. PARQUET        │   columnar, on disk
                                └─────────┬──────────┘
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
        ┌────────────────────┐                      ┌────────────────────┐
        │  E. Spark MLlib    │                      │  F. COPY loader    │
        │  train + score     │                      │  bulk insert       │
        └─────────┬──────────┘                      └─────────┬──────────┘
                  │  predicted salary per posting             │
                  └─────────────────┬─────────────────────────┘
                                    ▼
                          ┌────────────────────┐
                          │  G. Postgres raw.* │
                          └─────────┬──────────┘
                                    ▼
                          ┌────────────────────┐
                          │  H. dbt run        │   star schema
                          │  H2. dbt test      │   17 tests — FAILS the run
                          └─────────┬──────────┘
                                    ▼
                          ┌────────────────────┐
                          │  I. analytics.*    │  ◄── the ONLY thing the app reads
                          └─────────┬──────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐        ┌───────────────────┐       ┌────────────────────┐
│ J. jobs-svc   │        │ K. agent-service  │       │ L. Kafka events    │
│ search+charts │        │ 6 AI agents       │       │ posting.discovered │
└───────┬───────┘        └─────────┬─────────┘       └─────────┬──────────┘
        │                          │                           ▼
        │                          │                 ┌────────────────────┐
        │                          │                 │ M. match-notifier  │
        │                          │                 │ per-profile match  │
        │                          │                 └─────────┬──────────┘
        │                          │                           ▼
        │                          │                 ┌────────────────────┐
        │                          │                 │ N. notifications   │
        │                          │                 │ table              │
        └──────────┬───────────────┴───────────────────────────┘
                   ▼
        ┌────────────────────────────────┐
        │  O. GATEWAY  (JWT · CORS · rate limit)
        └───────────────┬────────────────┘
                        ▼
        ┌────────────────────────────────┐
        │  P. Next.js — 10 pages + bell  │
        └────────────────────────────────┘

   Above it all:  Q. AIRFLOW  triggers A→H2 every day at midnight
```

---

## Every node explained

### A — Two sources

| | |
|---|---|
| **In** | your profile's target roles + countries |
| **Out** | `real_postings.jsonl` (4,909) · `synthetic_postings.jsonl` (~196k) |
| **Code** | `pipeline/ingestion/job_apis.py` · `generate_synthetic_data.py` |

Adzuna is queried per search term, per country, 5 pages each. Terms come from **your
profile**, not a hardcoded list, so the warehouse fills with roles you would actually apply
to.

Four things are fixed here, at the edge, so nothing downstream needs per-source branching:
salary converted to **USD** (Adzuna returns each country's currency as a bare number),
**skills extracted** by regex from the description (Adzuna has no tags field), **seniority
inferred** from the title, and salaries below $5,000/yr **nulled** — those are monthly
Indian figures in an annual field, and a guessed salary is worse than a missing one.

**Why synthetic too:** 4,909 real rows do not justify Spark. The generated rows exist so
the distributed path runs at a size where its optimisations are measurable.

---

### B — Raw landing zone

| | |
|---|---|
| **In** | whatever the sources wrote |
| **Out** | the same bytes, unchanged |
| **Code** | `pipeline/data/raw/*.jsonl` |

Nothing edits this. If a bug is found in the ETL you reprocess from here instead of
re-downloading — which matters because Adzuna's free tier is a daily quota.

---

### C — PySpark ETL

| | |
|---|---|
| **In** | `data/raw/*.jsonl` — **both** files, one glob |
| **Out** | cleaned rows + 4 aggregate tables |
| **Code** | `pipeline/spark_jobs/etl_clean_jobs.py` |

One glob means **one cleaning path**, not one per source. It dedupes on `posting_id`,
parses salaries, trims titles, and materialises `skill_count`.

Three decisions worth being able to defend:

- **`cache()`** — Spark is lazy and recomputes the whole chain each time you ask for a
  result. `cleaned` is used 6 times, so without this the read-and-clean runs 6 times.
- **Native SQL, not a Python UDF** — a UDF ships every row out of the JVM into Python and
  back. Native expressions stay in the JVM.
- **`skill_count` computed once** — the ML model and the analytics both want it.

---

### D — Parquet

| | |
|---|---|
| **In** | cleaned rows |
| **Out** | `data/curated/postings.parquet` |

Stored by **column**, not row. Reading only `salary` never touches the other fields, and
repeated values compress hard. Same data, a fraction of the size and read time.

---

### E — Spark MLlib

| | |
|---|---|
| **In** | curated Parquet, **real postings only** |
| **Out** | `predicted_salary`, `salary_vs_market`, `pay_band` for **every** posting |
| **Code** | `pipeline/spark_jobs/mllib_salary_model.py` |

Gradient-boosted trees. Four features → salary. Trained fresh each run, not downloaded.

**Trained on real rows only, and that is the point.** On everything it scored R²=0.898 —
but 96% of that was seniority, because that is how the generator computes salary. It had
learned the generator, not the market. On real postings R² drops to **0.617**, region
becomes the top feature (a US role genuinely pays multiples of an Indian one), and GBT
beats the linear baseline by 4× the margin. *Prefer the number you can defend.*

Scoring still covers every posting — `--real-only` narrows what it **learns from**, never
what it is **applied to**.

---

### F — COPY loader

| | |
|---|---|
| **In** | curated Parquet |
| **Out** | rows in Postgres `raw.*` |
| **Code** | `pipeline/ingestion/load_to_warehouse.py` |

`COPY`, not row-by-row `INSERT`. INSERT sends 200,000 separate statements; COPY streams
the file once. Minutes versus seconds.

---

### G — Postgres `raw.*`

Landing tables, exactly as loaded. Nothing queries these except dbt.

---

### H — dbt run → H2 — dbt test

| | |
|---|---|
| **In** | `raw.*` |
| **Out** | `analytics.*` star schema |
| **Code** | `pipeline/dbt/` — 5 models, 17 tests |

Reshapes flat rows into:

```
              dim_company
                   │
  dim_skill ── bridge_posting_skill ── fact_job_posting
```

**Why a bridge table, not an array column:** array handling differs per engine (Postgres
`unnest` vs Snowflake `FLATTEN`). Bridge rows are plain SQL that works identically
everywhere.

**H2 is the quality gate.** 17 tests — no nulls in keys, no duplicate ids, salary in range.
`dbt test` **fails the pipeline** if any fail, so bad data never reaches the app. That is
a far better answer to "how do you ensure data quality" than "we check manually".

Indexes are attached here as **post-hooks**, because dbt drops and recreates each table
every run — an index made by hand survives until the next run and then silently vanishes.
Adding them took search from **2.0s → 0.52s**.

---

### I — `analytics.*`

The only thing the app is allowed to read. Everything here has passed the tests.

**This is the answer to "how do you stop an LLM hallucinating numbers":** you don't let it
near unvalidated data in the first place.

---

### J — jobs-service

| | |
|---|---|
| **In** | HTTP search/filter params |
| **Out** | JSON job rows + analytics |

Read-only, so it caches hard in Redis. Ordering is **real postings first**, then your
region, then how many of your skills the role wants, then salary.

---

### K — agent-service

| | |
|---|---|
| **In** | your question |
| **Out** | an answer + every tool call it made |

```
question → planner ─┬─ "none"        → direct reply, no tools
                    ├─ one specialist → that agent answers
                    └─ "orchestrator" → several agents, combined answer
```

The agent loop: **model asks for a tool → our Python validates and runs it → result goes
back → repeat.** The model executes nothing itself.

| Agent | Tools | Cannot |
|---|---|---|
| `job_matcher` | get_profile, search_jobs, get_job | write anything |
| `resume_tailor` | get_resume, get_job, save_tailored_resume | read email |
| `market_analyst` | get_market_analytics, search_jobs | see personal data |
| `skill_extractor` | none | — |
| `profile_extractor` | none | write the profile |
| `email_classifier` | none | **touch your resume** |

Limits: 6 tool calls per agent, 3 per single tool, 4 delegations.

**Why there is no sandbox here — and when there would be.** A sandbox is a locked room you
run code inside, so a mistake cannot escape it. The model needs none: it runs on the
provider's servers, it has no filesystem and no database connection, and all it can send
back is text naming a tool. There is nothing to contain.

That changes the moment the model writes code you execute. If the assistant generated its
own SQL — an "ask anything about the data" box — one bad query could `DROP TABLE` or read
another user's rows. **That** is where a sandbox earns its place: a read-only Postgres role
scoped to `analytics`, a statement timeout, a row cap. Same for an agent writing Python for
a chart — throwaway container, no network, no credentials.

> "Today the model can't run code, it picks from a fixed tool list — so there's nothing to
> sandbox. The moment I add text-to-SQL it's writing code I execute, and then it needs a
> read-only role and a statement timeout. A sandbox is what you add when you stop
> controlling *what* runs and can only control *where* it runs."

---

### L → M → N — Kafka, consumer, notifications

| | In | Out |
|---|---|---|
| **L** Kafka | one `posting.discovered` per new job | held in a topic |
| **M** match-notifier | every event + every profile | a match, or nothing |
| **N** notifications table | matches | rows the bell reads |

**Kafka carries, it decides nothing.** The consumer holds the logic: *2+ of your skills
overlap, OR your target role is in the title.* Two accounts on identical events get
different notifications.

**Why a broker at all:** several consumers read the same event independently, and one
breaking must not stop the others. With direct calls, a broken notifier takes ingestion
down with it.

**In-app, not email:** the consumer fires per posting, so 200 new jobs would send 200
emails. A badge showing "12" is the same information without the spam.

Duplicates are stopped by a **unique constraint** on (user_id, posting_id) — a consumer
restarts and forgets, a constraint does not.

---

### O — Gateway

| | |
|---|---|
| **In** | every browser request |
| **Out** | forwarded to one service, or 401 |

The only public door. Four middleware, in order: **CORS → logging → auth → rate limit.**

It verifies your JWT once so no other service needs auth code, and **deletes any
`X-User-Id` the client sent** before adding its own — without that, anyone could read your
profile by typing a header.

---

### P — Frontend

10 Next.js pages. Charts are **inline SVG, no chart library**. The bell polls an endpoint
that returns a single integer every 60 seconds.

---

### Q — Airflow

| | |
|---|---|
| **In** | the clock |
| **Out** | runs A → H2, daily |

Seven tasks, `@daily`, unpaused. What it adds over typing the command: **task-level
retries** (retries the failed step, not all 7 minutes), **dependencies** (`dbt test` runs
because `dbt run` succeeded), and **history** — "ran 47 times, failed twice, here are the
logs" is a question a shell script cannot answer.

Caveat worth saying first: it is a container on a laptop, so it runs while Docker runs,
and `catchup=False` means a missed day is missed rather than queued.

---

## Ports — every URL in one place

Start everything from `infra/`. **Always pass `--profile bigdata`** or Airflow, Kafka UI and
HDFS silently do not start:

```bash
cd infra
docker compose --profile bigdata up -d
```

### Open these in a browser

| Port | URL | What | Login |
|---|---|---|---|
| **3000** | <http://localhost:3000> | **The app itself** — 10 pages + bell | your own signup |
| **8090** | <http://localhost:8090> | **Airflow** — did the pipeline run, and did it work? | `admin` / `admin` |
| **8085** | <http://localhost:8085> | **Kafka UI** — did the events get delivered? | none |
| **8081** | <http://localhost:8081> | **Adminer** — browse the database directly | see below |
| 9870 | <http://localhost:9870> | HDFS namenode UI — rarely needed | none |

**For Kafka, 8085 is the only one you open.** The broker on `9092` is not a website — pointing
a browser at it shows nothing. 8085 is the UI that reads the broker for you.

### APIs — curl, not browser

| Port | Service | Note |
|---|---|---|
| **8000** | **gateway** | The only public door. The frontend talks to *this*, never the rest |
| 8001 | auth-service | behind the gateway |
| 8002 | agent-service | behind the gateway |
| 8003 | jobs-service | behind the gateway |
| 8004 | notification-service | behind the gateway |
| 8005 | mcp-server | on an isolated network with jobs-service only |

Hitting 8001–8005 directly bypasses JWT checks — useful for debugging, and exactly why they
are not published in a real deployment.

### Infrastructure — no UI

| Port | What |
|---|---|
| 5432 | Postgres (`careerlens` / user `careerlens`) |
| 6379 | Redis (jobs-service cache) |
| 9092 · 29092 | Kafka broker — `9092` from your machine, `29092` between containers |

`worker-service` and `match-notifier` have **no port** — they are background consumers. You
check them with `logs`, not a URL.

All ports come from `infra/.env`, so change one there if it collides locally.

---

## Restarting things

```bash
cd infra

# what is actually up, and on which ports
docker compose ps

# restart ONE service, leave the rest running
docker compose --profile bigdata restart airflow-webserver
docker compose --profile bigdata restart kafka-ui

# watch a service's output (Ctrl+C to stop watching, it keeps running)
docker compose logs -f airflow-scheduler
docker compose logs -f match-notifier

# stop everything / start everything
docker compose --profile bigdata down
docker compose --profile bigdata up -d

# after changing code in a service
docker compose --profile bigdata up -d --build jobs-service
```

Keep `--profile bigdata` on **every** command. Without it Compose does not know those
services exist, so `restart airflow-webserver` errors and a plain `up -d` brings back
everything *except* Airflow and Kafka UI.

**Airflow UI up but no DAG runs?** The webserver and the scheduler are two containers — the
page renders from the webserver, but nothing executes without the scheduler.
`docker compose --profile bigdata restart airflow-scheduler`.

`down` keeps your data — Postgres, Redis and Kafka are on named volumes. Only `down -v`
deletes it, which means re-running the whole pipeline.

---

## The two dashboards — what you see and how to read it

Both only exist when the `bigdata` profile is up (see above).

---

### Airflow — reading the DAGs screen

One row, `job_pipeline`. Every column answers a specific question:

| Column | Reads as | What it means |
|---|---|---|
| **Toggle** (blue = on) | unpaused | It will run on schedule. Off = loaded but dormant. |
| **Runs** | `2` green, `2` red | Two succeeded, two failed. The circles are counts, not buttons. |
| **Schedule** | `@daily` | Midnight. `catchup=False`, so a missed day is missed, not queued. |
| **Last Run** | a timestamp | When it last STARTED — not when it finished. |
| **Next Run** | tonight's date | When it will fire next. |
| **Recent Tasks** | green `7` | All 7 tasks of the newest run passed. A red circle here means that many failed. |

**A red run is not a problem to hide.** "It failed twice, here is why" is the entire reason
this exists rather than a cron job — the two red ones here are the runs from before Java
and dbt were fixed in the Airflow image.

**What to click, in order of usefulness:**

1. **The DAG name** → **Grid** view. Rows are tasks, columns are runs, each square is one
   task in one run. This is the screen you actually live in.
2. **Any square** → **Logs**. The real stdout of that step — where a failure explains
   itself.
3. **▶ (play)** in Actions → **Trigger DAG**. Runs it NOW rather than waiting for midnight.
   This is the button to use when you want to demo it.
4. **Graph** tab → the seven tasks as a flowchart. `ingest` and `generate` run in parallel,
   then everything after is a chain.
5. **Clear** on a single failed task → re-runs just that task, keeping everything already
   computed. This is the capability a shell script cannot offer, and worth demonstrating.

**Do not** touch the 🗑 in Actions — it deletes the run history, which is the useful part.

**Reading a failure:** Grid → find the red square → click → Logs → scroll to the bottom.
The error is almost always in the last twenty lines. Then Clear that one task rather than
re-running all seven minutes.

---

### Kafka UI — reading the cluster screen

The landing page shows the cluster: `careerlens`, 1 broker, 2 topics.

**"0 Bytes production / consumption" is not an error.** That is the live throughput right
now, and events only flow while the pipeline is ingesting.

**What to click:**

1. **☰ → Topics → `posting.discovered`** — the only topic that matters. The other,
   `__consumer_offsets`, is Kafka's own bookkeeping of who has read what.
2. **Messages** tab — the actual job events, as JSON, with their keys. This is the proof
   that publishing works, and the screen that would have caught the bug where the producer
   reported success while the topic stayed empty.
3. **Consumers** — shows `match-notifier` and its **lag**: how many messages it has not
   read yet. Lag climbing steadily means the consumer is down or too slow. Lag at zero
   means it is keeping up.

**What the events are for.** One `posting.discovered` is read by any number of independent
consumers. Today that is the match notifier, which decides per profile — two or more of
your skills overlap, OR your target role is in the title — and writes a row the bell
reads. An embedder for semantic search and a weekly digest are the obvious next two, and
adding either means deploying a consumer, not editing the pipeline.

That independence is the whole justification: with direct calls, a broken notifier takes
ingestion down with it.

---

### Adminer — the database

System `PostgreSQL` · Server `postgres` · User `careerlens` · Password from `infra/.env`
(`POSTGRES_PASSWORD`) · Database `careerlens`.

Two schemas worth knowing: `raw` is what the loader wrote, `analytics` is what dbt built
and the only one the app reads.
---

## What is automated

All of it, while Docker is up:

```bash
docker compose --profile bigdata up -d      # the whole setup
```

Verified: a full DAG run, all 7 tasks green, including a real 5-minute Adzuna fetch.

- Airflow UI **http://localhost:8090** — run history, per-task logs, retry one step
- Kafka UI **http://localhost:8085** — topics and message contents

---

## Where AI is — and isn't

| Feature | Actually |
|---|---|
| Analytics charts | **SQL** |
| Job search + filters | **SQL** |
| "vs market" badge | **Spark MLlib** — trained ML, not an LLM |
| Skill extraction in the pipeline | **regex** |
| Gmail first-pass filter | **Gmail's own search** |
| Assistant · resume tailoring · email labelling | **LLM** |

---

## The numbers

| | |
|---|---|
| Postings | 200,868 (4,909 real, charts use these only) |
| Skill rows | 737,525 |
| Spark vs MapReduce | **57.1% faster (2.33×)** |
| ML model | GBT **R² 0.617** vs baseline 0.475 — real data only |
| dbt tests | 17/17 |
| Python tests | 33 |
| Job search | 2.0s → **0.52s** after indexing |

---

## Over-engineered? Yes, deliberately — say so first

At 200k rows a laptop and a few scripts would do. Three tools are demonstrations:

| Tool | Needed here? | Instead | Becomes necessary when |
|---|---|---|---|
| **Spark** | no (~100MB) | pandas | data outgrows one machine |
| **Airflow** | no | `cron` | you need task retries + run history |
| **Kafka** | no | a direct call | a 2nd independent consumer appears |
| **Snowflake** | no | Postgres | scans outgrow one server |
| **Kubernetes** | no | Docker Compose | rolling deploys, self-healing |

**Load-bearing at any size:** dbt's tests · the star schema · Parquet · Redis caching.

> "Spark, Kafka and Airflow aren't load-bearing at 200,000 rows — pandas and a cron job
> would do it. I built them so the decisions were real: why cache, why a native expression
> over a UDF, why fan-out needs a broker. What IS load-bearing at any size is dbt's tests,
> the star schema and Redis caching."

---

## Best interview answers

**The bug worth telling:**
> "My salary cleaner stripped non-digits, turning 160000.0 into 1600000. Invisible for
> months because my generator only emitted whole numbers — the first real API value made
> average US salary read $10 million. A transformation correct for all *current* inputs
> isn't the same as a correct transformation."

**On the model:**
> "0.898 trained on everything, but 96% of that was seniority because that's how my
> generator computes salary — it had learned the generator, not the market. Retrained on
> real postings it's 0.617 and region became the top feature. I'd rather quote the number
> I can defend."

**The hardest bug:**
> "Ask the assistant something, navigate away, come back — no reply, no spinner, while the
> request had finished on the server. Took three attempts: the promise lived in the
> component, then in a per-page variable, then a shared registry that still deleted the
> result if it finished while you were away. The fix is a mailbox that holds the answer
> until a page collects it. An async result needs an owner that outlives whatever asked
> for it."

**On agents:**
> "The model never executes anything. It requests a tool by name, my code checks it's
> allowed and runs it. The email agent physically cannot touch a resume — it was never
> given that tool."

---

## Known gaps — say these before they're found

- **No incremental loading** — full refresh every run
- **Never actually distributed** — single-node Spark
- **No monitoring/alerting** on the pipeline
- Skills found on only ~20% of real postings (Adzuna truncates descriptions)
- Only ~24% of Indian postings publish a salary
- Airflow only runs while your laptop does

---

## Which files do you actually have to know?

**23,581 files sit in the folder. 180 are yours.** The rest is `node_modules`, `.next`,
`__pycache__` — downloaded dependencies, not code anyone wrote. `git ls-files | wc -l` is
the honest count, and it is the one to quote if anybody asks how big this is.

Of those 180, **twelve carry nearly all the reasoning.** Read these and you can explain
the system; everything else is a variation on a pattern you will already have seen.

### The twelve

| # | File | Why this one |
|---|---|---|
| 1 | `pipeline/spark_jobs/etl_clean_jobs.py` | The ETL. `cache()`, native SQL over a UDF, the salary bug |
| 2 | `pipeline/ingestion/job_apis.py` | Real data in: currency, skills, seniority, implausible salaries |
| 3 | `pipeline/spark_jobs/mllib_salary_model.py` | Train + batch score, and why real-only training |
| 4 | `pipeline/dbt/models/marts/fact_job_posting.sql` | The star schema in ~20 lines |
| 5 | `pipeline/dbt/models/staging/stg_postings.sql` | Why a staging layer exists at all |
| 6 | `pipeline/airflow/dags/job_pipeline_dag.py` | The 7 tasks and their dependencies |
| 7 | `services/agent-service/app/agents/base.py` | **THE agent loop.** ~60 lines. The most important file in the repo |
| 8 | `services/agent-service/app/agents/orchestrator.py` | Routing vs orchestration vs answering directly |
| 9 | `services/agent-service/app/agents/definitions.py` | Every agent and exactly which tools it may call |
| 10 | `services/gateway/app/middleware/auth_middleware.py` | Auth checked once, forged headers stripped |
| 11 | `services/jobs-service/app/routers/jobs.py` | Bound parameters, provenance ordering, profile ranking |
| 12 | `infra/docker-compose.yml` | How all of it is wired together |

That is **2,602 lines total**, comments included — an afternoon, not a mountain.

### Read them in this order

1. **`docker-compose.yml`** — see the pieces before any of their contents
2. **`etl_clean_jobs.py`** → **`fact_job_posting.sql`** — raw data becoming a warehouse
3. **`base.py`** — read this one twice; every agent, sub-agent and orchestrator is this loop
4. **`orchestrator.py`** → **`definitions.py`** — how the loop composes with itself
5. **`auth_middleware.py`** → **`jobs.py`** — how a request is trusted and served

### What to say when asked "how big is it?"

> "About 180 source files, but twelve carry the reasoning — the Spark ETL, the dbt models,
> the agent loop, the gateway middleware. The rest is CRUD around them. The agent loop is
> sixty lines and everything called multi-agent in this project is that loop composed with
> itself."

**Do not** say 23,000 files. That counts `node_modules`, and someone will know.

### The rest, in one line each

| Group | Files | What it is |
|---|---|---|
| Frontend pages | 10 | One per screen. `jobs`, `copilot`, `resume` are the meaty ones |
| Frontend shared | ~5 | `api.ts`, `AppShell.tsx`, `Charts.tsx`, `NotificationBell.tsx` |
| Auth service | ~10 | Login, profile, resumes, applications, notifications |
| Other services | ~15 | Each is a thin router over one concern |
| dbt models + tests | 12 | 5 models, the rest are test and schema definitions |
| k8s / Helm | ~12 | One template per object type |
| Tests | 33 | Security, parsing, pipeline logic |
| Docs | 18 | This file, the handbook, the deployment guide, and the `docs/` deep dives |

(`frontend/README.md` was deleted — it was untouched `create-next-app` boilerplate that said nothing about this project.)

---

**More detail:** [HANDBOOK.md](HANDBOOK.md) · **Deploying:** [DEPLOYMENT.md](DEPLOYMENT.md)
