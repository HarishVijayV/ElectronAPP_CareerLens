# CareerLens — The Complete Handbook

**Read this first.** Everything about this project: what every technology is, why it's
here, how it's used, what breaks without it, and exactly what changes when you host it.

> **In a hurry?** [CHEATSHEET.md](CHEATSHEET.md) is this whole document compressed to five
> minutes — the pipeline, every technology in one line, the numbers, and the interview
> answers. Come back here when you need the *why*.
>
> **Deploying it?** Read [DEPLOYMENT.md](DEPLOYMENT.md) instead — a click-by-click guide
> from a fresh cloud account to a live HTTPS site, including every URL, redirect and
> cookie setting that has to change. This handbook explains the system; that one
> ships it.

Written so someone who clones this repo cold can understand the whole system — and so
*you* can revise it before an interview.

---

## Table of contents


**PART 1 — UNDERSTAND IT**

- [1. What this project is](#1-what-this-project-is)

**PART 2 — RUN IT**

- [2. Running it locally](#2-running-it-locally)
- [3. Every credential and what breaks without it](#3-every-credential-and-what-breaks-without-it)

**PART 3 — HOW IT WORKS**

- [4. How data actually flows](#4-how-data-actually-flows)
- [5. How a request actually flows](#5-how-a-request-actually-flows)
- [6. The AI layer explained](#6-the-ai-layer-explained)

**PART 4 — DEEP DIVE ON EACH TECHNOLOGY**

- [7. Every technology — what, why, how](#7-every-technology-what-why-how)
- [8. Every service and container — what each one is for](#8-every-service-and-container-what-each-one-is-for)

**PART 5 — RUNNING IT FOR REAL**

- [9. Security decisions](#9-security-decisions)
- [10. HOSTING: everything that must change](#10-hosting-everything-that-must-change)

**PART 6 — LEARN FROM IT**

- [11. Real bugs and what they taught](#11-real-bugs-and-what-they-taught)
- [12. What's deliberately NOT here](#12-whats-deliberately-not-here)
- [13. Interview answers](#13-interview-answers)
- [Appendix A — Using OTHER MCP servers (general reference)](#appendix-a-using-other-mcp-servers-general-reference)

---

# PART 1 — UNDERSTAND IT

*Start here. What this is and how the pieces fit, before any code.*

---
## 1. What this project is

CareerLens is a job-hunting tool, built the way a company would build it rather than the
way a tutorial would. You upload your resume, and it finds real jobs you can apply to,
tells you how well you match them, rewrites your resume for a specific role, and tracks
every application by reading your inbox. Underneath that is a full data pipeline that
collects and processes job postings at scale, a machine-learning model that judges whether
a posting pays fairly, and a group of AI agents that answer questions using only real data.

**The real reason it exists** is to be a portfolio project where every layer is defensible
in an interview — data engineering, backend, AI, and infrastructure — instead of a
follow-along where you can't explain why anything is there.

### What you can actually do with it

**Set up your profile without typing it.** Upload a PDF, `.tex` or `.txt` resume and an AI
agent reads it and fills in your name, skills, target roles, seniority and countries. You
review and correct anything it got wrong, then save. Nothing is saved until you approve
it, because that profile decides which jobs get fetched and how every match is scored — a
wrong value there quietly poisons everything downstream.

**Browse jobs that are ranked for you.** The job board holds 200,868 postings, of which
4,909 are live listings from real job boards. Real ones always sort first and carry a
green "live" badge and a working apply link; generated ones are labelled "sample". On top
of that, your profile reorders the list: your regions first, then roles wanting the most
of your skills, then salary. Change your profile from India to the USA and the priority
follows. You can also filter by skill, region, seniority, salary, and whether a role pays
above or below market.

**Apply in one click, and have it tracked.** The Apply button opens the real listing and
records the application at the same time, because applying somewhere and then remembering
to log it is exactly the step people skip.

**See what the market actually looks like.** An analytics page shows which skills are most
in demand, how salary varies by seniority and region, hiring seasonality across the year,
and what premium each skill carries. Every chart is plain SQL over the warehouse — no AI
involved, and the page says so.

**Know whether a job pays fairly.** A machine-learning model trained on the real postings
predicts what each role should pay, and every posting carries the gap between that
prediction and its advertised salary — shown as "+$20,201" or "below market", and
searchable as a filter.

**Ask questions in plain English.** An assistant page routes your question to the right
specialist agent, or to several at once when the question needs more than one. Every tool
the agents called is shown with the answer, so nothing is unauditable.

**Tailor your resume to a specific job.** An agent rewrites your resume against a posting,
in LaTeX, and can compile it to PDF. Every version is kept, so an AI rewrite can never
destroy your original and you can compare versions.

**Get told when a matching job appears.** A bell in the top bar shows unread job matches
found by the pipeline. In-app rather than email, deliberately: the match consumer fires
once per matching posting, so a night where the pipeline finds 200 relevant jobs would
send 200 separate emails — the same information delivered in the most annoying possible
way. A badge reading "12" carries it at a glance and needs no SMTP provider at all.

Matching is per profile: **two or more of your skills overlap, OR your target role appears
in the title**. Two accounts on the same data get different notifications, which is the
whole point — one `posting.discovered` event, evaluated independently against every
profile. Duplicates are stopped by a unique constraint on (user_id, posting_id), because
every pipeline run republishes postings you have already been told about, and a consumer
restarts and forgets while a constraint does not.

**Track applications from your inbox.** Connect Gmail once, and a background worker reads
the last 30 days of mail, finds messages from recruiting systems, and classifies each as
applied, rejected, interview or offer. A funnel chart shows how far you got at each stage.

### How the whole thing is wired, end to end

Read this once and the rest of the handbook has somewhere to attach to. There are three
separate systems, and they only meet at the database.

**1. The pipeline — batch, runs on a schedule, no web requests involved.**

```
  Adzuna API (India + USA)  ─┐
  Remotive API              ─┼──> data/raw/*.jsonl        [landing zone, never edited]
  synthetic generator       ─┘            │
                                          ▼
                          PySpark ETL   (clean, dedupe, extract skills)
                                          │
                                          ▼
                          data/curated/*.parquet
                                          │
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
              Spark MLlib (train + score)          load_to_warehouse.py (COPY)
                        │                                   │
                        └─────────────> Postgres  raw.*  <──┘
                                          │
                                          ▼
                             dbt run   (build star schema)
                             dbt test  (17 checks — FAILS the run on bad data)
                                          │
                                          ▼
                             Postgres  analytics.*     ← the app only ever reads this
```

**2. The app — request/response, reads what the pipeline built.**

```
  Browser (Next.js)
        │  cookies: access + refresh token
        ▼
  API Gateway :8000        verifies the JWT once, strips forged identity headers
        │
        ├──> auth-service    users, profile, resumes, applications
        ├──> jobs-service    search + analytics  (Redis cache in front)
        ├──> agent-service   the AI agents
        └──> worker-service  Celery: Gmail sync, background jobs
```

**3. The AI layer — agents calling tools, on top of the app.**

```
  your question
        │
        ▼
  planner  ── picks ONE specialist, or escalates to the whole team
        │
        ▼
  agent loop:  model asks for a tool  ->  OUR Python validates and runs it
               ->  result goes back    ->  repeat until it answers
        │
        ▼
  tools call jobs-service / auth-service — never the raw files
```

**The one separation that matters:** the AI layer never touches raw data. It only reads
curated tables that already passed dbt's tests. That is the concrete answer to "how do you
stop an LLM making numbers up" — you don't let it near unvalidated data in the first place.

**Where each part lives in the repo:**

| Part | Directory |
|---|---|
| Ingestion (real + synthetic) | `pipeline/ingestion/` |
| Spark ETL and the ML model | `pipeline/spark_jobs/` |
| MapReduce comparison | `pipeline/mapreduce_demo/` |
| Star schema and tests | `pipeline/dbt/` |
| Scheduled DAG | `pipeline/airflow/dags/` |
| Backend services | `services/` (one folder each) |
| Website | `frontend/` |
| Docker, Kubernetes, CI | `infra/`, `k8s/`, `.github/` |

### Measured results (not claims)

| What | Result |
|---|---|
| Rows processed | 204,909 → **200,868** after removing 4,041 duplicates |
| Of which real | **4,909** live postings (Adzuna India + USA); the rest generated |
| Spark vs MapReduce | **57.1% faster (2.33×)** — median of 3 runs each, same aggregation |
| ML model | trained on REAL postings only: GBT R² = **0.617** vs linear baseline **0.475** |
| Warehouse | 200,868 postings + **737,525** skill rows |
| Data quality | 17/17 dbt tests passing |
| Tests | 33 Python tests |
| Kubernetes | 14/14 pods, self-healing verified by killing a pod mid-request |

Raw output committed in `pipeline/data/*.json` — you can reproduce every number.

**Why the model trains on real data only — and why a LOWER score is the better result.**

Trained on all 4,909 rows it scored R²=0.898, which looked excellent and meant nothing:

```
seniority_idx  0.9637     <- 96% of the model
region_idx     0.0330
skill_count    0.0031
```

Salary in the synthetic generator is computed almost entirely from seniority, so the model
had recovered the generator, not the job market. Retrained on the 2,992 live postings that
carry a salary:

| | All rows | **Real only** |
|---|---|---|
| GBT R² | 0.898 | **0.617** |
| Linear baseline R² | 0.865 | **0.475** |
| GBT's margin over baseline | +0.033 | **+0.142** |
| Top feature | seniority 96% | **region 72%**, seniority 25%, skills 3% |

Three things improved even though the headline number fell. Region dominating is a true
fact about the world (a US role pays multiples of an Indian one) rather than an artefact.
GBT now beats the linear baseline by 4× the margin, so the complex model earns its place
instead of tying. And the residual error is real market noise instead of a formula.

*Prefer the number you can defend.* A high score that only proves your generator was
deterministic dies on the first follow-up question.

Every posting is still scored, including synthetic ones — `--real-only` narrows what the
model LEARNS from, never what it is applied to.

The benchmark numbers come from a separate 200,000-row run recorded in
`benchmark_results.json`; the counts above are the current pipeline.

---

---

# PART 2 — RUN IT

*Get it on screen next. Everything after this is easier once you have seen it work.*

---
## 2. Running it locally

### Prerequisites
Docker Desktop, Python 3.11+, Node 18+, Java 17 (Spark), and on Windows `winutils.exe`.

### The whole app
```bash
cp infra/.env.example infra/.env       # add FIREWORKS_API_KEY
cd infra && docker compose up -d       # everything, including the frontend
```
→ http://localhost:3000

Every service has `restart: unless-stopped`, so starting Docker Desktop brings the whole
stack back with no command at all.

### The data pipeline
```bash
cd pipeline
pip install -r requirements.txt
python run_pipeline.py                 # generate → fetch → Spark → ML → load → dbt
python run_pipeline.py --benchmark     # include the MapReduce comparison
```

### Kubernetes
See [docs/KUBERNETES.md](docs/KUBERNETES.md). Short version:
```bash
kind create cluster --config k8s/kind-config.yaml
# install + pin ingress controller (commands in kind-config.yaml)
# build + kind load images
kubectl create secret generic careerlens-secrets --from-literal=...
helm install careerlens k8s/helm/careerlens
```

### Check everything
```bash
python check_setup.py     # services, auth, warehouse, credentials, agents, resume
```

---

---

## 3. Every credential and what breaks without it

| Credential | Cost | Required? | Without it |
|---|---|---|---|
| `FIREWORKS_API_KEY` | trial credits | for AI | Copilot returns a clear 502; everything else works |
| `GEMINI_API_KEY` | **free forever** (rate-limited) | no | fallback when Fireworks credits run out |
| `ADZUNA_APP_ID/KEY` | free | no | only Remotive fetched — no India/USA targeting |
| `GOOGLE_CLIENT_ID/SECRET` | free | no | Applications page shows "not configured"; manual entry still works |
| `TOKEN_ENCRYPTION_KEY` | — | no | falls back to `JWT_SECRET_KEY` (couples two secrets — fine for dev only) |
| `JWT_SECRET_KEY` | — | **yes** | already generated |
| Snowflake (5 vars) | 30-day trial | no | **auto-falls back to Postgres**, same models and tests |

Full walkthrough: [docs/CREDENTIALS.md](docs/CREDENTIALS.md)

---

---

# PART 3 — HOW IT WORKS

*The narrative: where data comes from, what a click does, and how the agents think.*

---
## 4. How data actually flows

```
job APIs (Adzuna IN+US, Remotive)  +  synthetic generator
                    ↓
        raw landing zone (immutable — reprocessable)
                    ↓
        PySpark ETL: dedupe, clean salaries, extract skills
                    ↓  (also emits a posting_skills bridge table)
        Spark MLlib: batch-score every posting vs market rate
                    ↓
        load into Postgres  (COPY, not INSERT — minutes vs seconds)
                    ↓
        dbt: staging → star schema → 17 quality tests
                    ↓
        analytics.fact_job_posting + dims  ← the app reads ONLY this
```

**Star schema:** `fact_job_posting` with `dim_company`, `dim_skill`, and
`bridge_posting_skill` for the many-to-many.

**Why a bridge table and not an array column:** array types differ across engines
(Postgres `unnest` vs Snowflake `FLATTEN`). Bridge rows are plain SQL that works
identically everywhere — the same portability reasoning as the rest of the chart.

Run it all: `cd pipeline && python run_pipeline.py`

### 5a. Where every row comes from — real vs generated

Two sources land in the same warehouse. **They are never blended in the UI**, because
conflating "a job you can apply to" with "a row that exists to make Spark work" would be
the most misleading thing this project could do.

| | **Real** | **Generated** |
|---|---|---|
| Rows | 4,909 | 146,972 |
| Written by | `pipeline/ingestion/job_apis.py` | `pipeline/ingestion/generate_synthetic_data.py` |
| Lands in | `data/raw/real_postings.jsonl` | `data/raw/synthetic_postings.jsonl` |
| Source | Adzuna (India + USA), Remotive | Faker + weighted random |
| `is_real` | `true` | `false` |
| Has an apply URL | yes | no |
| Shown in the UI as | green **live** badge, title links out | grey **sample** badge |

Both files are globbed by one Spark ETL (`data/raw/*.jsonl`), so there is a single
cleaning path, not one per source.

**Why keep synthetic at all?** Honestly: volume. 4,909 real rows do not justify Spark,
partitioning, or a MLlib training set — you could do all of it in pandas. The synthetic
rows exist so the big-data machinery is exercised at a size where it's actually the right
tool. Say that plainly in an interview; the alternative is pretending 5k rows needs a
cluster, which any interviewer will see through immediately.

**Why not go 100% real?** Adzuna's free tier caps results per query, so more real rows
means more search terms, not deeper pagination. 4,909 is roughly what 10 terms × 2
countries × 5 pages yields. It grows every time the pipeline runs and new postings appear.

**Ordering is provenance-first, everywhere:** `ORDER BY f.is_real DESC, f.salary DESC`.
Real postings come first even with no filter applied; salary is only the tiebreak inside
each group. The **Source** dropdown on the Jobs page can restrict to one or the other.

#### What real data cost to make usable

Live data is not cleaner than generated data — it's dirtier in ways generated data never
is. Four things had to be fixed before it could be trusted:

1. **Currency.** Adzuna returns each country's native currency as a bare number with no
   currency field. Indian postings arrived as `3000000` next to US postings at `160000`.
   Converted to USD at ingest (`FX_TO_USD`), with the rate **pinned, not fetched** — a live
   FX call would make the same input produce different output on different days, so two
   pipeline runs could no longer be compared.
2. **Skills.** Adzuna has no tags field. A comment in the code claimed "the ETL extracts
   from text"; it never did, so every real posting reached the warehouse with an empty
   skill list — silently breaking job matching and under-counting every skill chart. Now
   extracted by regex at ingest, against the *same* vocabulary the generator uses (if the
   two named skills differently, every chart would split into two populations).
3. **Implausible salaries.** Indian postings that quote a *monthly* figure in an annual
   field produced $217/year. These are **nulled, not repaired** — we can't distinguish
   monthly from hourly from part-time from typo, and a guessed salary is worse than a
   missing one because it silently enters the model's training set.
4. **A latent ETL bug the real data exposed.** `clean_salary()` stripped every non-digit,
   which turns `160000.0` into `1600000`. It was invisible for months because the generator
   only ever emitted whole numbers. The first fractional value made average US salary read
   **$10,186,234**. The lesson: *a transformation that is correct for all current inputs is
   not the same as a correct transformation.*

After the fixes, the numbers are finally plausible — and notice they're plausible in a way
generated data can't fake:

| Source | Postings | Min | Avg | Max |
|---|---|---|---|---|
| Adzuna US | 2,498 | $25,760 | $125,455 | $366,212 |
| Adzuna India | 2,412 | $6,024 | **$14,571** | $54,216 |
| Generated | 146,972 | $55,000 | $118,322 | $184,998 |

The India/US gap is real market structure the synthetic generator has no concept of.

**Known limits, stated up front:** only ~19% of real postings yield skills, because
Adzuna's free tier truncates descriptions to ~500 characters. Salary coverage is 100% for
US postings but only ~24% for Indian ones — Indian listings usually don't publish salary.
Neither is a bug to fix; both are properties of the source.

### 5b. How often does it refresh?

**Manually today; on a schedule when Airflow is running.**

```bash
cd pipeline && python run_pipeline.py            # everything
python run_pipeline.py --only real,spark,load,dbt  # just refresh postings
python run_pipeline.py --skip-real                 # offline, no API calls
```

`pipeline/airflow/dags/job_pipeline_dag.py` already defines the whole thing as a DAG on
`schedule="@daily"` with `catchup=False`. Airflow sits behind the `bigdata` compose
profile, so it is **off unless you ask for it**:

```bash
docker compose --profile bigdata up -d      # Airflow :8090, Kafka UI :8085
```

Daily is the right cadence and worth being able to defend: job postings don't change by
the minute, the whole run takes ~7 minutes, and Adzuna's free tier is a daily quota. A
5-minute schedule would burn the quota before lunch and republish identical rows. Nothing
here is streaming — Kafka carries `posting.discovered` events for fan-out, not ingestion.

---

---

## 5. How a request actually flows

**"Tailor my resume for job X"**

1. Browser sends the request with httpOnly cookies to the **Gateway**
   (`credentials: "include"` — without it the browser won't attach cookies cross-origin)
2. Gateway middleware, in order: **logging** → **auth** (verify JWT signature + expiry) →
   **rate limit** (Redis sliding window, keyed by the user id auth just established)
3. Gateway **strips any client-supplied `X-User-Id`** and sets its own from the verified
   token. ← security-critical; see §9 (Security)
4. Forwards to **agent-service**, which routes to `resume_tailor`
5. Agent runs the tool loop: `get_resume` → `get_job` → rewrite → `save_tailored_resume`
6. Response includes **every tool call it made**, rendered in the UI

**On a 401:** the frontend silently calls `/auth/refresh` once and replays the request.
One shared in-flight promise, because refresh *rotates* the token — parallel refreshes
would invalidate each other and log you out precisely *because* the security works.

---

---

## 6. The AI layer explained

**An agent is a loop.** That's it:

```
1. Send the LLM the conversation + the tools it may call
2. It replies with either an answer OR a request to call a tool
3. If a tool: run the real Python function, get a real result
4. Feed the result back, go to 1
5. Stop when it answers instead of calling another tool
```

**The model never executes anything.** It only *asks* for a tool by name. Our code decides
whether that's allowed and runs it. "The model requests, your code decides" is the whole
of agent security.

### The six agents and their permissions

| Agent | Tools it may call | Notably cannot |
|---|---|---|
| `skill_extractor` | none (pure extraction) | — |
| `profile_extractor` | none (given resume text) | **write the profile it describes** |
| `job_matcher` | `get_profile`, `search_jobs`, `get_job` | write anything |
| `resume_tailor` | `get_resume`, `get_resume_latex`, `get_job`, `save_tailored_resume` | read email |
| `market_analyst` | `get_market_analytics`, `search_jobs` | see personal data |
| `email_classifier` | none (given the email text) | **touch your resume** |

Least privilege is enforced **at execution time**, not just in the prompt — restricting
what a model *sees* is a soft boundary; checking again when the tool runs is the hard one.

### Routing vs orchestration — and how the mode is chosen

There are three ways a question gets answered, in increasing cost:

1. **Explicit** — the caller names the agent. Zero routing cost. Used where the UI already
   knows the intent (a "Tailor my resume" button is not ambiguous).
2. **Routing** — a planner reads the question and picks ONE specialist. Cheap, but it can
   only ever produce what a single agent can produce.
3. **Orchestration** — the orchestrator calls SEVERAL sub-agents *as tools* and writes one
   combined answer.

**The planner chooses between 2 and 3 itself.** That matters: before it could, "match jobs
to my resume and give me the top 3 fixes" went to `job_matcher` alone, which produced
something plausible — half an answer wearing a whole answer's clothes, which is exactly
what made the gap hard to notice. Measured on that question: 1 agent and 19 tool calls
before, 2 agents and 3 tool calls after.

Sub-agents are exposed **as tools**, which is why no new machinery was needed: an agent
that can call tools can call other agents, because from its point of view a sub-agent is
just a tool that happens to be expensive and intelligent. The same loop in `agents/base.py`
drives both levels. Ceiling of 4 delegations, since each one is a full nested LLM loop.

### Why agents make cost matter

One user question = **3–6 LLM calls** (plan → tool → read → answer). Inbox sync is **one
call per email**. That's why the provider defaults to Fireworks: a per-minute-limited free
tier stalls an agent *mid-loop* rather than failing cleanly.

### MCP — and how to actually use it

MCP (Model Context Protocol) publishes tools over a standard protocol so **any** AI client
can discover and call them — unlike a REST API, which needs custom integration code per
client.

**Use it right now:**

- **In Claude Code:** `.mcp.json` in the repo root is already configured. Open this folder
  in Claude Code with the stack running and the tools appear. Ask *"which skills pay above
  average?"* and it queries your warehouse.
- **In Claude Desktop:** add to its config:
  ```json
  { "mcpServers": { "careerlens": { "type": "http", "url": "http://localhost:8005/mcp" } } }
  ```
- **Verify by hand:**
  ```bash
  curl -X POST http://localhost:8005/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```

**8 tools exposed:** `search_jobs`, `job_details`, `market_overview`, `top_skills`,
`skill_premium`, `salary_by_seniority`, `salary_by_region`, `hiring_seasonality`.

**Zero personal data exposed**, and that's enforced by network isolation — the MCP
container runs on a Docker network shared only with `jobs-service`; `auth-service` doesn't
even resolve from it.

---

---

# PART 4 — DEEP DIVE ON EACH TECHNOLOGY

*Reference. Read straight through once, then come back to whichever tool you need.*

---
## 7. Every technology — what, why, how

The table is the summary. Below it, each data tool gets a proper explanation: what it is
in plain English, what it *can* do, what we actually made it do, and the real code.

| Tech | What it is | Why it's here | Where |
|---|---|---|---|
| **PySpark** | Splits data work across many CPUs | Processes more data than one machine's RAM holds | `pipeline/spark_jobs/etl_clean_jobs.py` |
| **Hadoop / MapReduce** | The older distributed model | To *prove* why Spark won, with a measured benchmark | `pipeline/mapreduce_demo/` |
| **Spark MLlib** | Machine learning on Spark | Predicts what a role should pay | `pipeline/spark_jobs/mllib_salary_model.py` |
| **Kafka** | Carries messages between services | Fan-out: announce once, many listeners | `pipeline/events.py` |
| **Airflow** | Runs the pipeline on a schedule | Retries, history, a DAG you can show | `pipeline/airflow/dags/` |
| **dbt** | SQL that builds and TESTS tables | Star schema + fails the run on bad data | `pipeline/dbt/` |
| **PostgreSQL** | The database | Serving layer for app and agents | `analytics.*` schema |
| **Snowflake** | Cloud data warehouse | Same dbt models, different target | `profiles.yml` target `warehouse` |
| **Redis** | In-memory store | Cache, rate limiting, Celery broker | `jobs-service` cache-aside |
| **Parquet** | Column-based file format | Small and fast to read | `pipeline/data/curated/` |

---

### Is this over-engineered? An honest audit, tool by tool

At 4,909 rows a laptop and a few Python scripts would do the job. Several tools here are
therefore **demonstrations of a pattern, not solutions to a problem I actually had** — and
saying so first is worth more than hoping nobody asks. An interviewer who works with these
tools daily will spot an unjustified Kafka in about ten seconds.

The useful framing is not "is it needed?" but **"at what point does it become needed, and
what would I use before that?"**

| Tool | Needed at 152k rows? | What would do instead | When it genuinely becomes necessary |
|---|---|---|---|
| **PySpark** | No — pandas fits in RAM | pandas | When data exceeds one machine's memory, or a job must survive a node dying mid-run |
| **Airflow** | No | `cron` + a shell script | When you have dependencies between tasks, retries, backfills, and need to answer "why did last Tuesday fail?" |
| **Kafka** | No | a direct function call | When several independent consumers react to one event and must not break each other |
| **dbt** | **Yes** | hand-written SQL, worse | Immediately — the tests are the point, and they scale down fine |
| **Star schema** | **Yes** | one wide table | Immediately — it is a modelling choice, not a scale choice |
| **Parquet** | **Yes** | CSV, slower and larger | Immediately — free win at any size |
| **Redis** | **Yes** | none | Immediately — analytics queries are slow and repeat constantly |
| **Snowflake** | No | Postgres | When analytical scans outgrow one server, or storage and compute need to scale apart |
| **MapReduce** | No, deliberately | nothing | Never. It is here to *measure* what Spark improved, then be retired |
| **Kubernetes** | No | Docker Compose | When you need rolling deploys, self-healing, or horizontal scaling |

#### The three that are honestly demonstrations

**Airflow vs a cron job.** For seven sequential steps run once a day, `cron` genuinely
does the job in one line. What cron does not give you:

* **Task-level retries.** Cron reruns the whole 7-minute pipeline; Airflow retries the one
  step that hit a network blip and keeps everything already computed.
* **Dependencies.** Cron runs on a clock. Airflow runs `dbt test` because `dbt run`
  succeeded, and skips the rest when it didn't.
* **History.** "It ran 47 times, failed twice, both in the Adzuna fetch, here are the
  logs" is a question cron cannot answer at all.
* **Backfills.** "Reprocess the last 30 days" is one command.
* **Visibility.** Someone who isn't you can see whether last night worked.

Those matter from roughly the point where a *second person* depends on the pipeline. At
one user on one laptop, cron is the right answer and Airflow is the learning exercise.

**Kafka vs a function call.** With one producer and one consumer, Kafka is strictly worse:
a broker to operate, a message format to version, and delivery semantics to reason about,
in exchange for nothing. Most "we use Kafka" portfolio projects are exactly this, and it
shows.

It earns its place only when **several independent consumers** react to the same event —
here a warehouse loader and a match notifier, with an embedder as an obvious third. The
test is: *if consumer B is broken, does the producer still work?* With direct calls, no.
With a broker, yes. That independence is what you are buying, and it is worth nothing
until you have more than one consumer.

**Spark vs pandas.** 152k rows is about 85MB. pandas handles that comfortably, in one
process, faster than Spark starts up. Spark is here so the code path is the one that still
works at 152 *million* — and so the caching, partitioning and native-expression decisions
are real decisions rather than things read about.

#### What that means for the numbers

The measured **57.1% Spark-over-MapReduce** result is real and reproducible, but it is
measured at a size where neither engine was under pressure. It demonstrates the
*direction* of the difference, not its magnitude at scale — where the gap widens
considerably, because MapReduce's per-step disk writes hurt more the more steps you have.

Quote it as "57% on my dataset", never as a general claim about the two engines.

#### How to say all this in an interview

> "Spark, Kafka and Airflow are not load-bearing at 152,000 rows — pandas and a cron job
> would do it. I built them because I wanted the decisions to be real ones: why cache,
> why a native expression instead of a UDF, why fan-out needs a broker. What IS
> load-bearing at any size is dbt's tests, the star schema, and Redis caching, and I'd
> keep all three in a project a tenth this size."

That answer is stronger than claiming you needed a cluster. It shows you can size a
solution to a problem, which is most of the actual job.

---

### What costs money, and what is just switched off

These get confused constantly, so it is worth separating them. **Almost everything here is
free.** Two tools are off on a laptop for RAM reasons, not cost reasons, and exactly one
thing has a bill attached.

| Tool | Cost | Running now? | Why |
|---|---|---|---|
| PySpark, Hadoop, dbt, Postgres, Redis, Parquet | **free** | yes | open source, runs locally |
| **Airflow** | **free** | **no** | ~600MB RAM. Behind the `bigdata` compose profile. |
| **Kafka** | **free** | **no** | ~600MB RAM. Same profile. |
| **Snowflake** | **paid** | **no** | $400 trial for 30 days, then it stops |
| Fireworks (LLM) | pay per call | yes | cheap; a question costs a fraction of a cent |
| Adzuna | free tier | yes | daily quota, plenty for one run a day |

Turn the two free ones on whenever you want them:

```bash
docker compose --profile bigdata up -d      # Airflow :8090, Kafka UI :8085
```

**Snowflake expiring costs you nothing**, and that is the point of writing transformations
in dbt: the same models target Postgres by changing one line, and `run_pipeline.py`
auto-detects which to use. Nothing in the repo breaks when the trial ends.

**Do not say "we use Kafka and Airflow" in an interview** while they are switched off. Say
"the producer and the DAG are written and run when the profile is up" — which is true, and
which nobody can catch you out on.

### The other containers on your machine

If you have ever run the Kubernetes demo, `docker ps` shows three extra containers named
`careerlens-control-plane`, `careerlens-worker` and `careerlens-worker2`, using around
3GB. Those are **kind** — a practice Kubernetes cluster, completely separate from the app.
The nine containers in the `infra` group are the whole application; the kind ones can be
deleted whenever you are not practising Kubernetes:

```bash
kind delete cluster --name careerlens
```

### PySpark — the one that does the actual work

**What it is, simply.** Normal Python reads a file one row at a time in one process. Spark
splits the file into chunks, hands each chunk to a different CPU core, and runs the same
code on all of them at once. Add machines and the same code uses those too, unchanged.

**What Spark can do generally:** read enormous files, join them, aggregate them, and write
results back — across a cluster, recovering automatically if a machine dies mid-job.

**What we make it do.** One job, `etl_clean_jobs.py`, reads both raw sources at once:

```python
raw = spark.read.json("data/raw/*.jsonl")   # real_postings + synthetic_postings
```

That glob matters. Both files go through **one** cleaning path, so there is no
per-source branching to keep in sync. Then:

```python
cleaned = (
    raw
    .dropDuplicates(["posting_id"])                    # same job posted twice
    .withColumn("salary_clean", clean_salary())        # "$120,000/yr" -> 120000
    .withColumn("title", F.trim(F.col("title")))
    .withColumn("skill_count", F.size(F.col("required_skills")))
    .filter(F.col("title").isNotNull())
)
cleaned.cache()
```

**Three decisions in there worth being able to defend:**

*`cache()`* — Spark is lazy. It doesn't compute anything until you ask for a result, and
then it recomputes the whole chain **every time you ask again**. We use `cleaned` six
times (a count, four aggregations, one write), so without `cache()` Spark would redo the
read-and-clean six times. One line, often the difference between a slow job and a fast one.

*Native SQL instead of a Python function.* Salary cleaning could have been a Python UDF.
It isn't:

```python
numeric = F.regexp_replace(F.col(column).cast("string"), r"[^0-9.]", "")
whole = F.regexp_extract(numeric, r"^(\d+)", 1)
return F.when(whole == "", None).otherwise(whole.cast("long"))
```

A UDF forces every row out of the JVM into a Python process and back. Native expressions
compile into Spark's engine and stay put. *"Avoid Python UDFs when a native expression
exists"* is one of the highest-value Spark answers you can give.

*Compute once, not per consumer.* `skill_count` is materialised here because the ML model
and the analytics both want it. Deriving it twice downstream would mean two more joins.

**Output goes to Parquet, not CSV.** Parquet stores data by *column*. Reading only
`salary` doesn't touch the other columns, and repeated values compress hard. Same data,
a fraction of the size and read time.

**What breaks without it:** nothing, at this size — pandas would cope with 152k rows. Say
that plainly. Spark is here so the code path is the one that still works at 152 *million*.

---

### Hadoop MapReduce — kept to prove a point

**What it is.** The older way to split work across machines. You write two functions:
`map` turns each record into key-value pairs, `reduce` combines all values for a key.

**Why it's still here.** Not for production — to *measure* the claim that Spark is faster
instead of repeating it. `mapreduce_demo/` runs the same aggregation both ways:

```
MapReduce median: 2.672s
Spark median:     1.147s
-> 57.1% faster (2.33x)
```

**Why Spark wins, in one sentence:** MapReduce writes to disk between every step; Spark
keeps intermediate results in memory. Multi-step jobs pay that disk cost repeatedly.

---

### dbt — SQL that also tests itself

**What it is.** You write `SELECT` statements in files. dbt works out the dependency order,
creates the tables, and runs data tests against the result.

**What it can do:** build models in order, materialise them as tables or views, test data
quality, generate documentation and a lineage graph.

**What we make it do.** Reshape flat postings into a **star schema**:

```
                  dim_company
                       |
   dim_skill --- bridge_posting_skill --- fact_job_posting
```

One big fact table of postings; small lookup tables around it. That shape makes
"average salary by company" fast, and it is the standard warehouse layout.

**Why a bridge table and not an array column.** A posting has many skills and a skill
belongs to many postings. You *could* store an array. We don't, because array handling
differs per engine (`unnest` in Postgres, `FLATTEN` in Snowflake) — bridge rows are plain
SQL that works identically everywhere. Same portability reasoning as the rest of the stack.

**The staging layer earns its keep.** `stg_postings.sql` renames and casts, nothing else.
One real example:

```sql
coalesce(lower(is_real::text) in ('true','t','1'), false) as is_real
```

`is_real` arrives as *text* holding `'True'`, because synthetic rows have no such field
and the loader widened the column. Exactly one model knows about that quirk; every mart
downstream just reads a boolean.

**The tests are the point.** 17 of them — no nulls in keys, no duplicate ids, salary in a
sane range. `dbt test` **fails the pipeline** if any fail. That is what stops bad data
reaching the app, and it is a much better answer to "how do you ensure data quality?" than
"we check manually".

**Indexes are attached here too**, via post-hooks — because dbt drops and recreates each
table on every run, so an index created by hand disappears at the next run.

---

### Spark MLlib — the salary model

**What it is.** Spark's machine-learning library. Same distributed engine, so training
happens on the cluster rather than by pulling data into one process.

**What we make it do.** Learn what a job *should* pay, then compare that to what it
*does* pay:

```
advertised $145,000 - predicted $125,000 = +$20,000 -> "above market"
```

Four inputs: seniority, region, remote, skill count. One output: salary.

**Trained from scratch on our own data.** Not downloaded, not fine-tuned. `GBTRegressor`
(gradient-boosted trees), with a `LinearRegression` baseline alongside — because
comparing against something simple is what turns *"I trained a model"* into *"I evaluated
a model"*.

**Batch scoring, not per request.** Every posting is scored once during the pipeline and
the result written to the warehouse. Features only change when the pipeline runs, so
paying Spark's startup cost on every HTTP request would be absurd. Real-time inference is
for when the features depend on the request itself.

**The honest part.** Trained on everything it scored R²=0.898 — and 96% of that was
seniority, because that is precisely how the synthetic generator computes salary. It had
learned the generator, not the market. Trained on real postings only, R² drops to 0.617,
region becomes the top feature, and the complex model beats the baseline by 4× the margin.
**Prefer the number you can defend.** Full comparison in §1 (Measured results).

---

### Kafka — the announcer

**What it is.** A message log. One service publishes an event; any number of others
subscribe. It is **not** storage — messages expire after days and you never query it like
a database.

**What we make it do.** After ingest, announce the new postings once:

```
pipeline finds 200 new jobs
        |
        +-- "posting.discovered" --+-- worker: notify matching users
                                   +-- worker: update skill counts
                                   +-- (add a fourth listener, no pipeline change)
```

**The honest justification.** Without Kafka the pipeline would have to call each consumer
directly, and adding a listener would mean editing the pipeline. That is the fan-out
argument, and it is the only one that holds at this size.

**Currently off** (behind the `bigdata` compose profile), so the ingest prints
`Kafka unavailable — events skipped`. The pipeline finishes normally: an announcement
failing must never stop a data load. Say "the producer is wired and runs when the profile
is up", not "we use Kafka in production".

---

### Does it actually run on a schedule? Honestly: not yet

The DAG is **loaded but paused**, and has never run — `airflow dags list-runs` returns
"No data found". Right now the pipeline runs when you type `python run_pipeline.py`, and
at no other time.

Two things have to be true for a 2am run to happen, and both are easy to miss:

1. **The DAG must be unpaused.** New DAGs start paused on purpose, so switching Airflow on
   never launches something unexpected.
   ```bash
   docker compose exec airflow-scheduler airflow dags unpause job_pipeline
   ```
2. **The machine must be awake.** Airflow is a container on your laptop. Shut the laptop
   and the scheduler stops with it — and `catchup=False` means it does **not** run the
   missed days when you come back. A missed day is simply missed.

That second point is the real argument for hosting it: on a server that never sleeps, the
schedule genuinely holds. On a laptop, "daily at 2am" means "daily at 2am **on days the
laptop happens to be on at 2am**", which is not a schedule.

**The run history** lives at http://localhost:8090 (Airflow UI). Once it has run a few
times you get a grid of every run, green or red per task, with the logs of any failure
and a button to re-run just the failed step. That history is the thing you cannot get
from typing a command yourself — it is the reason Airflow exists.

## The two dashboards — what you see and how to read it

Both only exist when the `bigdata` profile is up:

```bash
cd infra && docker compose --profile bigdata up -d
```

| URL | What | Login |
|---|---|---|
| <http://localhost:8090> | **Airflow** — did the pipeline run, and did it work? | `admin` / `admin` |
| <http://localhost:8085> | **Kafka UI** — did the events actually get delivered? | none |
| <http://localhost:8081> | Adminer — browse the database directly | see below |

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

### Airflow — the scheduler

**What it is.** Runs your pipeline steps as a **DAG** — a graph of tasks with dependencies,
retries, and a history of every run.

**What we make it do.** The same 7 steps, on `schedule="@daily"`, with `catchup=False` so
switching it on doesn't backfill a year of runs. It calls the same scripts
`run_pipeline.py` does — neither duplicates logic.

**Why daily.** Postings don't change by the minute, a full run is ~7 minutes, and Adzuna's
free quota is daily. A 5-minute schedule would exhaust the quota before lunch republishing
identical rows.

Also off by default: it costs ~600MB of RAM to have running on a laptop.

---

### dbt vs Postgres — the confusion worth clearing up

They are not alternatives, and they don't overlap. **dbt has no database of its own.**

* **Postgres** is the *place*. It stores the tables.
* **dbt** is the *builder*. It writes SQL that Postgres executes, in the right order.

dbt connects to Postgres, sends `CREATE TABLE ... AS SELECT ...`, and the resulting table
lives in Postgres. Turn dbt off and the tables stay exactly where they are — you just have
no repeatable way to rebuild them.

Concretely, in this project:

| | Who does it |
|---|---|
| Store users, resumes, applications | **Postgres** (the app writes directly, via SQLAlchemy) |
| Load 4,909 cleaned rows into `raw.postings` | **Python** (`load_to_warehouse.py`, using `COPY`) |
| Turn `raw.postings` into the star schema | **dbt** (`dbt run` — 5 models) |
| Check the result isn't broken | **dbt** (`dbt test` — 17 tests) |
| Serve `/jobs/search` to the website | **Postgres** (the API queries it directly) |

So the flow is: Python loads **raw** → dbt reshapes it into **analytics** → the app reads
**analytics**. dbt only ever runs during the pipeline. It is not involved in serving a
single web request.

**Why not just write the SQL by hand?** You could. dbt buys three things that matter:
it works out model dependency order for you, it *tests* the output and fails the run on
bad data, and swapping Postgres for Snowflake is a config change rather than a rewrite.

**One-line version:** Postgres is the warehouse; dbt is the crew that arranges it and
checks nothing is broken.

---

### PostgreSQL, Snowflake, Redis — where things live

**Postgres** holds two separate things: the app's own data (users, resumes, applications)
and the `analytics.*` star schema the pipeline writes. Loading uses `COPY`, not row-by-row
`INSERT` — minutes versus seconds, because `INSERT` sends 152k separate statements while
`COPY` streams the file once.

**Snowflake** is the same *kind* of thing as Postgres — storage — but a cloud warehouse
built for large analytical scans. The same dbt models target it by changing one config
line. It auto-falls back to Postgres when no credentials exist, which is why the trial
expiring costs nothing.

**Redis** holds nothing permanent: cached query results, rate-limit counters, and Celery
task results. Three jobs, one dependency. Cache-aside pattern — check Redis, miss, query
Postgres, write back.

---

### Where each piece of YOUR data lives

| Data | Stored where | Notes |
|---|---|---|
| Resume text + LaTeX | Postgres `TEXT` | |
| Original PDF | Postgres `LargeBinary` | actual bytes — PDF text extraction is lossy |
| Refresh token | Postgres | **hashed**, never raw, like a password |
| Access token (JWT) | httpOnly cookie | JavaScript cannot read it |
| Job postings | Postgres `analytics.*` | written by the pipeline |
| Cache / task results | Redis | disposable |

---

### Backend

| Tech | What it is | Why it's here |
|---|---|---|
| **FastAPI** | Async Python web framework | Typed, auto-generates OpenAPI docs, same language as the data stack |
| **API Gateway** | Single public entrypoint | Verify JWT once at the edge; every other service stays private |
| **JWT** | Signed stateless token | Fast auth check without a DB lookup per request |
| **Refresh tokens** | Opaque, stored hashed | JWTs can't be revoked early — refresh tokens can |
| **bcrypt** | Password hashing | Deliberately slow, salted per password |
| **Celery** | Distributed task queue | Slow work (inbox sync) off the request path |
| **SQLAlchemy** | ORM | Parameterized queries — SQL injection impossible by construction |

### AI

| Tech | Why it's here |
|---|---|
| **Tool-calling loop (from scratch)** | ~60 lines in `agents/base.py`. Proves you understand the mechanism, not just a library |
| **LangGraph** | The same flow as an explicit graph — so you can compare scratch vs framework |
| **Provider abstraction** | Fireworks / Gemini / OpenAI / Anthropic swappable by one config line |
| **MCP server** | Exposes job-market data to *external* AI clients — a genuinely different capability |

### Frontend

Next.js 16 (App Router), React 19, TypeScript, Tailwind v4. Charts are **inline SVG, no
charting library** — every visual decision is explainable, and there's no black box.

### Infrastructure

| Tech | Why |
|---|---|
| **Docker** | Same environment everywhere |
| **Docker Compose** | Whole stack, one command, auto-restarts |
| **Kubernetes** | Self-healing, rolling deploys, horizontal scaling |

---

---

## 8. Every service and container — what each one is for

### Why microservices at all

Being honest first: at this size, one FastAPI app would work. The split earns its place
for three specific reasons, and those are the ones to give in an interview rather than
"microservices are good".

**Different scaling needs.** The agent service is slow and expensive — one question is
3–6 LLM calls. Job search is fast and hot. As one app you would have to scale the whole
thing to handle more searches, dragging idle agent capacity along with it.

**Different blast radius.** The LLM provider going down should not stop people browsing
jobs. Separate processes mean a failure stays where it happened.

**A real security boundary.** The MCP server sits on its own Docker network and physically
cannot reach `auth-service`. Inside one app that would be a comment in the code hoping
nobody imports the wrong module; across containers it is enforced by the network itself.

### The nine containers

| Container | Port | What it does | What breaks without it |
|---|---|---|---|
| **frontend** | 3000 | The Next.js website | No UI; the APIs still work |
| **gateway** | 8000 | The only public entrypoint. Verifies the JWT once, strips forged identity headers, forwards to the right service | Nothing is reachable |
| **auth-service** | 8001 | Signup, login, tokens, profile, resumes, applications, Google OAuth | No login, no resumes |
| **agent-service** | 8002 | The AI agents, the planner, the orchestrator, the tool loop | Assistant and resume tailoring |
| **jobs-service** | 8003 | Job search and analytics queries, with Redis caching | Job board and charts |
| **worker-service** | — | Celery worker. Gmail sync and other slow jobs. No HTTP port — it pulls work from a queue | Inbox tracking |
| **mcp-server** | 8004 | Exposes job data to external AI clients over MCP. Isolated network | External AI access only |
| **notification-service** | — | OUTBOUND channels only (email/SMS providers). In-app notifications are rows in auth-service, not here | Nothing today — the bell does not use it |
| **postgres** | 5432 | App data + the `analytics.*` warehouse | Everything |
| **redis** | 6379 | Cache, rate limiting, Celery broker | Slower; background jobs stop |

Kafka, Airflow and their databases exist too but sit behind the `bigdata` compose profile,
so they are off unless you ask for them.

### What each service actually owns

**gateway** is the security boundary. Every request from a browser lands here first. It
checks the JWT once so no other service has to, and it **deletes** any `X-User-Id` header
the client sent before adding its own — without that, anyone could read anyone's profile
by typing a header. It's a proxy, so it holds no data.

**auth-service** owns everything about *you*: your account, hashed password, hashed refresh
tokens, profile, resume versions (including the original PDF bytes), applications, and your
encrypted Google token. It is the only service that touches those tables.

**jobs-service** is read-only. It queries `analytics.*` and never writes. That is why it
can cache aggressively — nothing it serves changes except when the pipeline runs.

**agent-service** holds the agent loop, the six agent definitions, the planner and the
orchestrator, plus the LangGraph version of the same flow for comparison. It calls the
other services through their APIs, exactly like the browser would.

**worker-service** has no HTTP interface at all. It waits on a Redis queue and does slow
work — reading 30 days of Gmail and classifying each message is N API calls plus N LLM
calls, far too slow to hold a web request open for.

**mcp-server** is the odd one out: it exists for *other* AI clients, not for our website.
Its network isolation is the point — verified by confirming it gets a connection error
when it tries to reach `auth-service`.

---

### Docker and Docker Compose

**Docker** packages each service with its own Python version and dependencies, so
"works on my machine" stops being a category of bug. Each service has its own
`Dockerfile`.

**Docker Compose** describes all nine containers, their networks, volumes and start order
in one file, and starts them with one command:

```bash
cd infra && docker compose up -d
```

Three things in `docker-compose.yml` worth understanding:

*`depends_on` with `condition: service_healthy`* — services wait for Postgres to actually
accept connections, not merely to have started. Without it, `auth-service` boots first,
fails to connect, and dies.

*`restart: unless-stopped`* — a crashed container comes back by itself, and everything
returns automatically after a reboot.

*Named volumes* — `postgres_data` lives outside the container, so `docker compose down`
does not delete your 200,868 postings.

*`profiles: [bigdata]`* — Kafka and Airflow are declared but only start when asked, which
is why a normal `up` doesn't cost you 1.5GB of RAM.

---

### Kubernetes — and what it adds over Compose

Compose already runs everything. Kubernetes is here because it does four things Compose
cannot, and those four are the answer to "why bother?".

**Self-healing.** Compose restarts a crashed container. Kubernetes restarts a container
that is *running but broken* — because it keeps asking each pod whether it is actually
healthy, and replaces it when the answer is no.

**Rolling deploys.** New version starts, passes its readiness check, receives traffic, and
only then does the old one stop. Compose replaces containers with a gap in service.

**Horizontal scaling.** `replicas: 3` runs three copies with load spread across them, and
the HorizontalPodAutoscaler adds more when CPU rises.

**Declarative state.** You describe what should exist; Kubernetes continuously makes
reality match. Delete a pod by hand and it comes back — verified here by killing one
mid-request and watching the request still succeed.

**The objects used here, in plain terms:**

| Object | What it is |
|---|---|
| **Pod** | One running container (or a few that must live together) |
| **Deployment** | "Keep N identical pods alive" — handles restarts and rollouts |
| **Service** | A stable internal address in front of pods that come and go |
| **Ingress** | Routes outside traffic to the right Service by URL path |
| **ConfigMap** | Non-secret settings, injected as environment variables |
| **Secret** | The same, for passwords and API keys |
| **StatefulSet** | Like a Deployment, but for things with disks — Postgres and Redis |
| **PersistentVolumeClaim** | The disk itself, which survives the pod being replaced |
| **HPA** | Adds and removes pods automatically based on CPU |

**Why Postgres is a StatefulSet and not a Deployment.** Deployment pods are
interchangeable and get random names; if one is replaced, a new empty one appears.
StatefulSet pods keep a stable identity and stay attached to the same disk, which is
exactly what a database needs.

**Three probes, three different questions** — this is the part most people get wrong:

| Probe | Question | What Kubernetes does if it fails |
|---|---|---|
| **startup** | "Has it finished booting?" | Waits longer before judging it |
| **readiness** | "Can it serve traffic right now?" | Stops sending it requests |
| **liveness** | "Is it wedged?" | Kills and restarts it |

Getting these confused causes real outages: a liveness probe that is too aggressive
restarts a healthy-but-slow service in a loop.

Local cluster is **kind** (Kubernetes in Docker), so the whole thing runs on a laptop with
no cloud account.

---

### Helm — why not just apply the YAML

Raw Kubernetes YAML means six nearly-identical files, one per service, differing by a name
and a port. Change a label and you edit six files and miss one.

**Helm** is templating plus release management. The chart in `k8s/helm/careerlens/` defines
each service once and loops over a list in `values.yaml`:

```yaml
services:
  - name: gateway
    port: 8000
    replicas: 2
  - name: jobs-service
    port: 8000
```

That renders 21 Kubernetes objects from one template. It also gives you `helm upgrade` and
`helm rollback`, so a bad deploy is one command to undo, and `helm install` with different
values deploys a staging copy without duplicating any YAML.

Check what it will produce before applying anything:

```bash
helm template careerlens k8s/helm/careerlens     # render, don't install
helm install careerlens k8s/helm/careerlens
```

---

# PART 5 — RUNNING IT FOR REAL

*What changes between your laptop and a server anyone can reach.*

---
## 9. Security decisions

| Concern | How it's handled |
|---|---|
| Passwords | bcrypt + per-password salt; SHA-256 pre-hash so bcrypt's 72-byte limit can't silently truncate |
| Sessions | 15-min JWT + 7-day refresh token, **rotated** on every use |
| Token storage | httpOnly cookies — JavaScript cannot read them, so XSS can't steal them |
| Identity forwarding | Gateway **strips** client `X-User-Id` before setting its own |
| SQL injection | Bound parameters everywhere; never string-formatted SQL |
| Rate limiting | Redis sliding window at the gateway |
| CORS | Explicit allow-list of one origin |
| Third-party tokens | Google refresh tokens **encrypted** (Fernet) at rest |
| Secret leakage | Pre-commit hook blocks key-shaped strings and any `.env` |
| MCP exposure | Separate service, isolated network, aggregate data only |
| LLM code execution | **Not possible** — the model picks from a fixed tool list; nothing it returns is ever executed as code |

**The one worth memorising:** *"auth-service trusts the `X-User-Id` header — which is safe
only because exactly one component can write it. The gateway strips whatever the client
sent and sets it from the verified JWT. Trusted-header auth is a good pattern behind a
gateway and a critical vulnerability without one."*

### Sandboxing — what this project has, and the one feature that would demand more

The word means two unrelated things, and interviews conflate them:

| Sandbox | Means | Here |
|---|---|---|
| Docker, gVisor, a VM | **isolation** — a locked room, so a failure can't escape | what we have |
| Stripe / PayPal "sandbox" | **practice mode** — fake data, so nothing costs money | not applicable, no payments |

**What we have is the isolation kind, and it is deliberately modest.** Every service is its
own container, so a Spark job that exhausts memory or a notifier that crashes takes nothing
else down. `mcp-net` goes further: a network segment with exactly two members, so
mcp-server has *no route* to Postgres — not a rule someone can forget to apply.

Say **isolation**, not sandbox, when describing containers. If pushed — *"is a container
really a sandbox?"* — the honest answer scores better than the confident one:

> "Not a security sandbox. Containers share the host kernel, so it's fault and dependency
> isolation, not a trust boundary. For genuinely untrusted code I'd need gVisor or a VM."

**The AI layer needs no sandbox at all, for a reason worth stating precisely.** The model
runs on the provider's servers. It holds no database handle, no filesystem, no shell — the
only thing it can emit is text naming a tool it would like called. Our Python decides
whether that call is permitted and runs it. `email_classifier` cannot reach a resume not
because a wall blocks it, but because that tool was never in its list. *A capability you
were never granted needs no containment.*

**The one feature that would flip this:** letting the model decide the query. An "ask
anything about the data" box means the LLM writes SQL and we execute it — and now a bad or
adversarial generation can `DROP TABLE`, read another user's rows, or hang the warehouse
with a runaway join. The containment then has to be real:

- a **read-only Postgres role** scoped to `analytics` — DDL and writes simply fail
- a **statement timeout** and a row cap, so no single query can monopolise the database
- allow-list the statement type; reject anything that isn't a `SELECT`
- an agent that runs generated *Python* (say, for a chart) gets a throwaway container with
  no network and no credentials

> "A sandbox is what you add when you stop controlling *what* runs and can only control
> *where* it runs. Today the model picks from a fixed tool list, so there's nothing to
> sandbox. Text-to-SQL would change that in one commit."

---

---

## 10. HOSTING: everything that must change

**This is the section people get wrong.** Local works; hosting breaks in a dozen small
ways. Here is every one.

### 10.1 Google OAuth redirect URI ← the one that bites first

Google matches redirect URIs **character for character**.

1. Google Cloud Console → **APIs & Services → Credentials** → your OAuth client
2. Under **Authorized redirect URIs**, **add** (keep localhost so local dev still works):
   ```
   https://yourdomain.com/api/auth/google/callback
   ```
3. ⚠️ **HTTPS is mandatory** for any non-localhost redirect URI. Plain `http://` is
   rejected outright.
4. Update `.env`:
   ```
   GOOGLE_REDIRECT_URI=https://yourdomain.com/api/auth/google/callback
   FRONTEND_URL=https://yourdomain.com
   ```

**Also:** while the app stays in Google's "Testing" mode, only accounts you add as test
users can connect Gmail (100 max). Publishing needs verification, and `gmail.readonly` is
a **restricted** scope — that means a privacy policy, demo video, and a paid third-party
security assessment. Not worth it for a portfolio project. Demo it on your own account.

### 10.2 Cookies — three settings that must all change

```bash
COOKIE_SECURE=true            # cookies only sent over HTTPS
COOKIE_DOMAIN=yourdomain.com  # not "localhost"
```
And if the frontend and API end up on **different domains**, `SameSite=Lax` stops sending
cookies on cross-site requests — you'd need `SameSite=None; Secure` **and** a CSRF token.
Simplest fix: serve both from one domain (`/` and `/api`), which is what the Ingress
already does.

### 10.3 CORS

```bash
FRONTEND_ORIGIN=https://yourdomain.com
```
The gateway allow-lists exactly one origin. Leave it as `localhost:3000` and every browser
request fails CORS.

### 10.4 Frontend API URL — a build-time trap

`NEXT_PUBLIC_*` variables are **baked in at build time**, not read at runtime.

```bash
NEXT_PUBLIC_API_BASE_URL=https://yourdomain.com/api
```
Change it and you must **rebuild the image**. Setting it in the container env after the
build does nothing — a genuinely confusing failure.

Note it's resolved by the **browser**, so it must be a public URL, never a Docker/k8s
service name.

### 10.5 Kubernetes / Helm

```bash
helm upgrade --install careerlens k8s/helm/careerlens \
  --set global.imageRegistry=ghcr.io/harishvijayv/careerlens \
  --set global.imageTag=sha-<commit> \
  --set global.imagePullPolicy=Always \
  --set ingress.host=yourdomain.com \
  --set ingress.tls.enabled=true \
  --set postgres.enabled=false \
  --set redis.enabled=false
```

| Setting | Local | Hosted | Why |
|---|---|---|---|
| `imagePullPolicy` | `IfNotPresent` | `Always` | kind loads images locally; cloud must pull |
| `imageTag` | `latest` | `sha-<commit>` | traceable deploys and real rollbacks |
| `postgres/redis.enabled` | `true` | `false` | use managed services — see below |
| `ingress.tls.enabled` | `false` | `true` | real HTTPS |

### 10.6 HTTPS certificates

```bash
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set installCRDs=true
```
Then a `ClusterIssuer` for Let's Encrypt. Free, auto-renewing.

### 10.7 Managed database — and back it up

Stop self-hosting Postgres in production. Running your own means owning backups, failover,
upgrades and point-in-time recovery.

```bash
DATABASE_URL=postgresql+psycopg://user:pass@your-managed-host:5432/careerlens
REDIS_URL=redis://your-managed-redis:6379/0
```

⚠️ **If you do self-host it, set up backups first.** A StatefulSet with no backup is one
`kubectl delete pvc` away from total loss.

### 10.8 Secrets

Never `kubectl create secret` by hand in production, and remember a Kubernetes Secret is
base64-**encoded**, not encrypted. Use **Sealed Secrets** or **External Secrets Operator**,
and enable encryption at rest on the cluster.

### 10.9 Database migrations ← will break you

The app currently calls `Base.metadata.create_all()`, which creates **missing** tables but
cannot express a **change** to an existing one. The first time you alter a column on real
data, it silently does nothing.

**Add Alembic before you have data you care about.**

### 10.10 The pipeline in cloud

| Local | Cloud equivalent |
|---|---|
| Local files / HDFS | S3 / GCS / OCI Object Storage |
| Local Spark | EMR, Dataproc, Databricks — or keep on a VM |
| Docker Compose Airflow | MWAA, Cloud Composer, or self-hosted |
| Postgres | RDS / Cloud SQL |

Pipeline **logic** doesn't change — only where storage and compute physically run. That
portability is the whole point of how it was built.

### 10.11 Enable CI deploy

In `.github/workflows/ci.yml`, change `if: false` on the deploy job to
`if: github.ref == 'refs/heads/main'`, and add `KUBE_CONFIG` (base64 kubeconfig) as a repo
secret. It already does `helm rollback` on failure.

### 10.12 Hosting checklist

- [ ] Google redirect URI added (HTTPS) + `.env` updated
- [ ] `COOKIE_SECURE=true`, `COOKIE_DOMAIN` set
- [ ] `FRONTEND_ORIGIN` = real domain
- [ ] `NEXT_PUBLIC_API_BASE_URL` set **and image rebuilt**
- [ ] `imagePullPolicy=Always`, image tagged by SHA
- [ ] TLS via cert-manager
- [ ] Managed Postgres + Redis, **with backups**
- [ ] Secrets via Sealed/External Secrets
- [ ] Alembic migrations in place
- [ ] CI deploy enabled with `KUBE_CONFIG`
- [ ] Resource limits reviewed for real traffic
- [ ] Billing alert set ← genuinely important

---

---

# PART 6 — LEARN FROM IT

*The parts that are actually worth talking about in an interview.*

---
## 11. Real bugs and what they taught

Full list in [docs/LESSONS.md](docs/LESSONS.md). The best fifteen:

1. **`clean_salary()` inflated every fractional salary 10–100×.** It stripped all
   non-digits, so `160000.0` became `1600000`. Invisible for months because the synthetic
   generator only ever emitted whole numbers; the first real converted value made average
   US salary read **$10,186,234**. → ***A transformation that is correct for all current
   inputs is not the same as a correct transformation.***
2. **Real job data never actually loaded.** `job_apis.py` read Adzuna keys via `os.getenv`
   but nothing loaded `infra/.env` outside Docker, so it printed `adzuna: SKIPPED` and fell
   back to synthetic. → *A failure message that reads like a configuration choice will not
   be investigated. Say "skipped because X was empty", not "skipped".*
3. **A comment claimed work that was never implemented.** "the ETL extracts skills from
   text" — it didn't, so every real posting reached the warehouse with an empty skill list,
   silently breaking job matching. → *Comments describing behaviour rot silently; only
   tests and assertions can't lie.*
4. **Any backend blip signed the user out.** The session check was
   `.catch(() => router.push("/login"))`, which caught network errors and 5xx as well as
   401s. Verified: with a valid cookie, `/api/auth/me` returns 500 while auth-service
   restarts — indistinguishable from "logged out" to that catch. → *Distinguish "the server
   said no" from "the server said nothing." Only the first is an auth failure.*
5. **Gateway let anyone impersonate anyone.** It forwarded client-supplied `X-User-Id`.
   → *If a value is trusted downstream, the boundary producing it must destroy any client copy.*
6. **Only one of two auth cookies survived login.** `dict(headers)` collapsed duplicate
   `Set-Cookie`. → *HTTP headers are a multimap, not a map.*
7. **Pipeline worked once, broke on every re-run.** dbt views depended on tables being
   replaced. → ***A pipeline that hasn't been run twice hasn't been tested.***
8. **MCP publisher reported success while the topic stayed empty.** `send()` is async and
   nothing awaited the future. → *A publisher that lies about delivery is worse than none.*
9. **The AI recommended jobs that do not exist.** `search_jobs`' docstring said "real
   postings" while the call passed no provenance filter. Because the warehouse orders
   real-first, the padding only appeared once a filter matched fewer rows than the limit —
   then the agent quietly topped up with generated ones. A run advised applying to
   "Johnson, Cooper and Reilly" and "Klein PLC", both Faker output, with confident
   reasoning attached. → *The dangerous failure is not a wrong answer, it is a plausible
   one. And a docstring is not a filter.*
10. **"No space left on device" with 894GB free.** Job search 500'd on
   `could not resize shared memory segment`. Docker gives a container 64MB of `/dev/shm`
   and Postgres uses shared memory for parallel workers. → *Read the error's subject, not
   its verb — it said shared memory, not disk. Defaults sized for a toy dataset are
   quietly wrong on a real one.*
11. **The analytics schema had ZERO indexes.** dbt builds tables and never indexes them,
   so every search sequentially scanned 4,909 rows. Adding them as dbt post-hooks (not
   by hand — a `table` materialisation is dropped and rebuilt each run, taking any manual
   index with it) took search from 2.0s to 0.52s. → *If your ORM or transform tool creates
   the tables, something still has to create the indexes.*
12. **CI failed on code that passed locally, forever.** `app/layout.tsx` uses `LayoutProps`,
   a type Next GENERATES into `.next/types` during dev or build. `.next` is gitignored, and
   CI typechecked before building. Locally it always passed because a previous `next dev`
   had left the types behind. → *A check that depends on leftover build output is not a
   check. Run the same command locally that CI runs.*
13. **An answer that arrives nowhere.** Ask the assistant something, navigate away while
   it thinks, come back: no reply and no spinner — while the request had completed on the
   server and, for a resume rewrite, already saved a new version. Three fixes, each
   exposing the next: the promise lived in the component (destroyed on unmount), then in a
   per-page module variable (Resume to Assistant and back still lost it), and finally the
   shared registry deleted the result on settle, so anything finishing *while you were
   away* was discarded — the most common case, since going elsewhere is the entire point.
   Now a mailbox: a finished result is HELD until a page collects it. → *An async result
   needs an owner that outlives whatever asked for it.*
14. **The same Spark task passed at 12:37 and failed at 14:39** on identical code. Driver
   memory was hardcoded at 4g; by the afternoon eighteen containers were up and only
   ~2.9GB was free, so the JVM could not reserve its heap and died mid-`fit` with a
   Py4JError that reads like a Spark bug. → *An out-of-memory failure that depends on what
   else is running looks flaky, so it gets retried instead of diagnosed.*
15. **Frontend "Running" and "Ready" but serving nothing in k8s.** No `/health` route, so
   readiness failed forever and the Service had zero endpoints. → *`kubectl get endpoints`
   is the fastest way to tell a probe failure from an app bug.*

---

---

## 12. What's deliberately NOT here

Being able to say why something is absent is as valuable as building it.

| Missing | Why |
|---|---|
| LinkedIn/Indeed scraping | No free API; scraping violates their ToS. A portfolio project built on a ToS violation is a bad interview story |
| Alembic migrations | Known gap — §10 (Hosting). Needed before real data |
| Prometheus/Grafana | Known gap. "How would you know if this broke?" is the question it answers |
| Non-root containers | Images run as root; `runAsNonRoot: true` is a standard review item |
| NetworkPolicy | Done at the Docker layer for MCP; k8s equivalent not yet written |
| Load testing | HPA is configured but never proven. A `k6` run would turn config into evidence |
| Terraform | Clicking through a console isn't reproducible |
| MCP authentication | Fine on localhost; public hosting needs token auth first |

---

---

## 13. Interview answers

**"Walk me through this project."**
> A data pipeline processes job postings through Spark into a dbt star schema, six FastAPI
> microservices serve it behind an API gateway with JWT auth and Redis caching, and a
> multi-agent AI layer sits on top. It runs on Kubernetes with self-healing and a CI
> pipeline that publishes images to a registry. I benchmarked my Spark implementation
> against raw MapReduce — 57% faster — and I can explain exactly why.

**"Why Hadoop if Spark replaced it?"**
> To prove I understand *why* Spark won, with my own numbers. MapReduce writes intermediate
> results to disk between every stage; Spark keeps them in memory across a DAG. I
> implemented the same aggregation both ways and measured 2.33×.

**"Is 152,000 rows big data?"**
> No, and I wouldn't claim it. It's the volume that fits on a laptop while exercising
> genuinely distributed code paths. The same job runs unchanged on a cluster — only the
> master URL changes. I'd rather quote a number I measured.

**"Only 4,909 of those are real. Isn't the rest padding?"**
> It's padding with a purpose, and I'd say so before you asked. Free job APIs cap out in
> the thousands, and 5,000 rows doesn't justify Spark — pandas would do. The generated
> rows exist so the distributed path runs at a size where it's the right tool. The real
> rows are what the product actually surfaces: they sort first, they carry an apply link,
> and they're the ones that exposed three bugs the clean synthetic data never could.

**"How do you stop the AI hallucinating numbers?"**
> Structurally. Agents can only read curated data that passed dbt's tests, they can only
> call tools I gave them, and the UI shows every tool call so any answer is auditable.

**"What was your hardest bug?"**
> The gateway forwarded a client-supplied `X-User-Id` header that downstream services
> trusted as identity — anyone could read anyone's data by sending a header. Found it by
> testing my own security claim rather than assuming it. Same thing happened with the MCP
> server: I documented a privacy boundary, tested it, found Docker put everything on one
> network, and enforced it properly with network isolation.

**"How does it recover from failure?"**
> Four layers: the container restart policy, liveness probes for wedged-but-alive
> processes, Deployment replicas for lost pods or nodes, and `helm rollback` on a failed
> release. I verified the third by deleting a gateway pod mid-request — zero failed
> requests, replacement running in 40 seconds.

---

---

## Appendix A — Using OTHER MCP servers (general reference)

> **Not part of this project.** CareerLens *provides* an MCP server; this appendix is about
> *consuming* someone else's. Kept here as general notes, using GitHub's server as the
> example, because the two transport styles below apply to every MCP server you'll meet.

### The two transports

| | Remote (`type: http`) | Local (`command: ...`) |
|---|---|---|
| Runs where | the provider's servers | your machine |
| Transport | HTTP | **stdio** — the client launches it as a subprocess and talks over stdin/stdout |
| Needs Docker/npx | no | yes |
| Config key | `url` | `command` + `args` |

Remote suits a service someone else operates. Local (stdio) suits a tool that must touch
your filesystem, or that you'd rather not send data to a third party.

*(CareerLens' own server uses HTTP rather than stdio because it's a long-lived container
several clients talk to — a stdio server is started fresh by one client and dies with it.)*

### Example — GitHub's MCP server

**Step 1.** Create a token: https://github.com/settings/personal-access-tokens/new →
*Only select repositories* → grant Contents / Issues / Pull requests.

**Step 2.** Store it as an environment variable (PowerShell), then reopen the terminal:
```powershell
setx GITHUB_TOKEN "github_pat_..."
```

**Step 3.** Add ONE of these to `.mcp.json`:

```jsonc
// Remote — nothing to install
"github": {
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
}

// Local — runs on your machine, needs `docker pull ghcr.io/github/github-mcp-server`
"github": {
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
           "ghcr.io/github/github-mcp-server"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
}
```

**Step 4.** Restart the client and check its MCP panel for a connected status.

### The rule that matters

**Always `${GITHUB_TOKEN}`, never the literal token.** `.mcp.json` is committed to the
repo. A leaked key is exactly what got a Google Cloud project in this account suspended
for "abusive activity consistent with hijacking" — see §11 (Real bugs). The pre-commit hook in
`.githooks/` would probably catch it, but don't make that your only defence.

### Is it worth adding here?

Honestly, no — `git` and `gh` already cover this repo's needs, and it's one more token to
manage. MCP servers earn their place when they reach something your existing tools can't:
a hosted API, a private knowledge base, or — as with CareerLens — your own data.

---

---

## Where to go next

| Doc | For |
|---|---|
| [SETUP_CHECKLIST.md](SETUP_CHECKLIST.md) | Getting it running |
| [docs/CREDENTIALS.md](docs/CREDENTIALS.md) | Every key |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [docs/DATA_ENGINEERING.md](docs/DATA_ENGINEERING.md) | Pipeline deep dive |
| [docs/AGENTIC_AI.md](docs/AGENTIC_AI.md) | Agent design |
| [docs/AUTH_AND_SECURITY.md](docs/AUTH_AND_SECURITY.md) | Auth deep dive |
| [docs/KUBERNETES.md](docs/KUBERNETES.md) | Running on k8s |
| [docs/CLOUD_LEARNING_PLAN.md](docs/CLOUD_LEARNING_PLAN.md) | Getting to cloud, free |
| [docs/LESSONS.md](docs/LESSONS.md) | 16 real bugs |
