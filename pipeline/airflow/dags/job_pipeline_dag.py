"""
The DAG that runs the whole batch pipeline on a schedule.

Each task shells out to a script that already exists and already works standalone — the
DAG's job is sequencing, retries and visibility, NOT reimplementing logic. Keeping the
scripts runnable on their own matters: you can debug one step directly instead of
through the scheduler, and this file stays readable.

Mounted into the Airflow containers at /opt/airflow/dags (infra/docker-compose.yml,
bigdata profile), with the rest of pipeline/ at /opt/airflow/pipeline.
"""
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator

default_args = {
    "owner": "careerlens",
    # Retries matter here because two tasks call third-party APIs. Transient network
    # failures are normal, not exceptional, and a pipeline that dies on one blip isn't
    # production-shaped.
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(hours=1),
}

PIPELINE = "/opt/airflow/pipeline"
# The pipeline directory is mounted whole, so its data folder is INSIDE it. Pointing at
# /opt/airflow/data was a path that never existed in the container: the DAG parsed fine,
# scheduled fine, and failed at the first task that touched a file with
# "Path does not exist: file:/opt/airflow/data/raw/*.jsonl". A wrong constant costs
# nothing until something reads it.
DATA = f"{PIPELINE}/data"

# Absolute path to dbt's own virtualenv, not the bare `dbt` on PATH. dbt and Airflow pin
# incompatible versions of jinja2 and SQLAlchemy, so dbt is installed in a separate venv
# (see infra/airflow.Dockerfile) and must be invoked from there. Calling plain `dbt` would
# either find nothing or, worse, find a different one.
DBT = "/home/airflow/dbt-venv/bin/dbt"
DB_URL = "postgresql://careerlens:change_me@postgres:5432/careerlens"

with DAG(
    dag_id="job_pipeline",
    description="ingest -> Spark ETL -> MLlib -> warehouse -> dbt models + tests",
    default_args=default_args,
    schedule="@daily",
    start_date=datetime(2026, 1, 1),
    catchup=False,  # don't backfill a year of runs the first time this is switched on
    max_active_runs=1,  # Spark jobs are memory-hungry; never run two at once
    tags=["careerlens", "data-engineering"],
) as dag:

    ingest_real = BashOperator(
        task_id="ingest_real_postings",
        bash_command=(
            f"python {PIPELINE}/ingestion/job_apis.py "
            f"--out {DATA}/raw/real_postings.jsonl "
            f'--terms "Data Engineer,Analytics Engineer,Machine Learning Engineer,'
            f"Data Scientist,Data Analyst,Backend Engineer,Software Engineer,"
            f'Big Data Engineer,MLOps Engineer" '
            f"--countries in,us "
            # Same as run_pipeline.py: union each user's target roles into the search, so
            # the DAG and the manual command fetch the same thing. Two paths that drift
            # apart is how "it works when I run it" starts.
            f"--from-profiles"
        ),
    )

    generate_synthetic = BashOperator(
        task_id="generate_synthetic_postings",
        bash_command=(
            f"python {PIPELINE}/ingestion/generate_synthetic_data.py "
            f"--rows 200000 --out {DATA}/raw/synthetic_postings.jsonl"
        ),
    )

    spark_etl = BashOperator(
        task_id="spark_etl",
        bash_command=(
            f"python {PIPELINE}/spark_jobs/etl_clean_jobs.py "
            f'--input "{DATA}/raw/*.jsonl" --output {DATA}/curated/postings.parquet'
        ),
    )

    train_model = BashOperator(
        task_id="train_salary_model",
        bash_command=(
            f"python {PIPELINE}/spark_jobs/mllib_salary_model.py "
            f"--input {DATA}/curated/postings.parquet "
            f"--model-out {DATA}/models/salary_gbt --metrics-out {DATA}/model_metrics.json"
        ),
    )

    load_warehouse = BashOperator(
        task_id="load_warehouse",
        bash_command=(
            f"python {PIPELINE}/ingestion/load_to_warehouse.py "
            f'--curated-dir {DATA}/curated --database-url "{DB_URL}"'
        ),
    )

    # --profiles-dir . rather than dbt's default of ~/.dbt: the profile lives beside the
    # project in pipeline/dbt/profiles.yml (gitignored, copied from profiles.yml.example),
    # and $HOME/.dbt does not exist in the Airflow image. Without this the task dies in
    # under two seconds with "Invalid value for '--profiles-dir'", which reads like a dbt
    # bug rather than a missing setup step.
    dbt_run = BashOperator(
        task_id="dbt_run",
        bash_command=f"cd {PIPELINE}/dbt && {DBT} run --profiles-dir .",
    )

    # dbt test runs AFTER the models are built and is the pipeline's quality gate: if the
    # warehouse data is wrong, the run goes red here rather than silently serving bad
    # numbers to the dashboard.
    dbt_test = BashOperator(
        task_id="dbt_test",
        bash_command=f"cd {PIPELINE}/dbt && {DBT} test --profiles-dir .",
    )

    # Both ingestion sources feed the same ETL (fan-in); everything after is sequential
    # because each step consumes the previous step's output.
    [ingest_real, generate_synthetic] >> spark_etl >> train_model >> load_warehouse >> dbt_run >> dbt_test
