"""
Application tracking + the funnel analytics that make it worth tracking.

The interesting endpoint here is /applications/funnel — it answers "what actually happens
to my applications", and /applications/resume-performance answers "which resume version
gets more replies". Those two questions are the reason this feature exists; a list of
applications by itself is just a spreadsheet.
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_claims
from app.models import Application, ApplicationEvent

router = APIRouter(prefix="/applications", tags=["applications"])


@router.post("/sync-inbox")
def trigger_inbox_sync(
    days: int = Query(30, ge=1, le=365, description="how many days of mail to scan"),
    claims: dict = Depends(get_current_claims),
):
    """Kick off a Gmail sync in the background and return immediately.

    Returning a task id instead of the result is the point: the sync makes N Gmail calls
    and N LLM calls, which is far too slow to hold an HTTP request open for. The UI polls
    /applications afterwards.

    `days` defaults to 30 because that's what routine syncs need — status moves within
    weeks, and anything older was already captured by an earlier run (messages are deduped
    on gmail_message_id, so nothing is ever classified twice). The parameter exists for the
    first sync on a freshly-connected account, where there IS no earlier run to have caught
    the older mail.
    """
    import os

    from celery import Celery

    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    celery = Celery(broker=redis_url, backend=redis_url)
    task = celery.send_task(
        "app.tasks.email_sync.sync_inbox",
        # Positional args must line up with sync_inbox(user_id, max_messages, lookback_days).
        kwargs={"user_id": claims["sub"], "lookback_days": days},
    )
    return {"queued": True, "task_id": task.id, "lookback_days": days}


@router.get("/sync-status/{task_id}")
def sync_status(task_id: str, claims: dict = Depends(get_current_claims)):
    """Check if the background Gmail sync is still running.
    
    Returns:
    - status: queued/running/completed/failed
    - progress: 0-100 (if running)
    - count: number of applications synced (if completed)
    """
    import os
    from celery import Celery
    
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379/0")
    celery = Celery(broker=redis_url, backend=redis_url)
    task = celery.AsyncResult(task_id)
    
    # task.state: PENDING, STARTED, SUCCESS, FAILURE, RETRY
    if task.state == "PENDING":
        return {"status": "queued", "progress": 0}
    elif task.state == "STARTED":
        # task.info is the dict sent by worker during progress updates
        progress = task.info.get("current", 0) if isinstance(task.info, dict) else 0
        return {"status": "running", "progress": progress}
    elif task.state == "SUCCESS":
        return {"status": "completed", "count": task.result.get("count", 0) if isinstance(task.result, dict) else 0}
    elif task.state == "FAILURE":
        return {"status": "failed", "error": str(task.info)}
    else:
        return {"status": "unknown"}


# Ordered pipeline stages. Order matters for the funnel: each stage counts applications
# that reached AT LEAST that far.
FUNNEL_STAGES = ["applied", "interview_invite", "offer"]


class ApplicationCreate(BaseModel):
    company: str
    role: str | None = None
    posting_id: str | None = None
    status: str = "applied"
    resume_version: str | None = None


class ApplicationUpdate(BaseModel):
    status: str | None = None
    role: str | None = None
    resume_version: str | None = None


class ApplicationOut(BaseModel):
    id: str
    company: str
    role: str | None
    posting_id: str | None
    status: str
    resume_version: str | None
    source: str
    applied_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


@router.get("", response_model=list[ApplicationOut])
def list_applications(
    status_filter: str | None = None,
    claims: dict = Depends(get_current_claims),
    db: Session = Depends(get_db),
):
    query = db.query(Application).filter(Application.user_id == claims["sub"])
    if status_filter:
        query = query.filter(Application.status == status_filter)
    return query.order_by(Application.updated_at.desc()).all()


@router.post("", response_model=ApplicationOut, status_code=status.HTTP_201_CREATED)
def create_application(
    payload: ApplicationCreate,
    claims: dict = Depends(get_current_claims),
    db: Session = Depends(get_db),
):
    """Manual entry. The email sync creates these automatically, but you always want a
    manual path — inbox classification will never catch everything."""
    application = Application(
        user_id=claims["sub"],
        company=payload.company,
        role=payload.role,
        posting_id=payload.posting_id,
        status=payload.status,
        resume_version=payload.resume_version,
        source="manual",
    )
    db.add(application)
    db.flush()

    db.add(ApplicationEvent(application_id=application.id, status=payload.status, detail="created manually"))
    db.commit()
    db.refresh(application)
    return application


@router.patch("/{application_id}", response_model=ApplicationOut)
def update_application(
    application_id: str,
    payload: ApplicationUpdate,
    claims: dict = Depends(get_current_claims),
    db: Session = Depends(get_db),
):
    application = (
        db.query(Application)
        .filter(Application.id == application_id, Application.user_id == claims["sub"])
        .first()
    )
    if not application:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Application not found")

    updates = payload.model_dump(exclude_unset=True)

    # A status change is history, not just a new value — record an event alongside it.
    if "status" in updates and updates["status"] != application.status:
        db.add(
            ApplicationEvent(
                application_id=application.id,
                status=updates["status"],
                detail=f"changed from {application.status}",
            )
        )

    for field, value in updates.items():
        setattr(application, field, value)

    db.add(application)
    db.commit()
    db.refresh(application)
    return application


@router.get("/funnel")
def funnel(claims: dict = Depends(get_current_claims), db: Session = Depends(get_db)):
    """applied → interview → offer, with conversion rates.

    Counts are computed from EVENTS, not from the current status: an application that is
    now 'rejected' still passed through 'applied', and may well have reached
    'interview_invite' first. Counting only current status would make the funnel collapse
    as outcomes arrive, which is exactly backwards.
    """
    user_id = claims["sub"]

    reached = dict(
        db.query(ApplicationEvent.status, func.count(func.distinct(ApplicationEvent.application_id)))
        .join(Application, Application.id == ApplicationEvent.application_id)
        .filter(Application.user_id == user_id)
        .group_by(ApplicationEvent.status)
        .all()
    )

    total = db.query(func.count(Application.id)).filter(Application.user_id == user_id).scalar() or 0
    rejected = reached.get("rejected", 0)

    stages = []
    baseline = max(reached.get("applied", 0), total)
    for stage in FUNNEL_STAGES:
        count = reached.get(stage, 0) if stage != "applied" else baseline
        stages.append(
            {
                "stage": stage,
                "count": count,
                "percent_of_applied": round(count / baseline * 100, 1) if baseline else 0.0,
            }
        )

    return {
        "total_applications": total,
        "rejected": rejected,
        "awaiting_response": max(total - rejected - reached.get("offer", 0), 0),
        "stages": stages,
    }


@router.get("/resume-performance")
def resume_performance(claims: dict = Depends(get_current_claims), db: Session = Depends(get_db)):
    """Response rate per resume version — the A/B test that makes tailoring measurable
    instead of a vibe.

    Deliberately reports the sample size next to every rate: 1 interview from 2
    applications is a 50% response rate and means nothing. Showing the rate without the
    denominator is how people fool themselves with small samples.
    """
    totals = (
        db.query(Application.resume_version, func.count(Application.id))
        .filter(Application.user_id == claims["sub"])
        .group_by(Application.resume_version)
        .all()
    )

    # Positive outcomes come from EVENTS, so an application that reached an interview and
    # was later rejected still counts as a positive response — which is what "did this
    # resume get replies?" actually means.
    positives = dict(
        db.query(
            Application.resume_version,
            func.count(func.distinct(ApplicationEvent.application_id)),
        )
        .join(ApplicationEvent, ApplicationEvent.application_id == Application.id)
        .filter(
            Application.user_id == claims["sub"],
            ApplicationEvent.status.in_(["interview_invite", "offer"]),
        )
        .group_by(Application.resume_version)
        .all()
    )

    results = []
    for version, applications in totals:
        positive = positives.get(version, 0)
        results.append(
            {
                "resume_version": version or "(unversioned)",
                "applications": applications,
                "positive_responses": positive,
                "response_rate_percent": round(positive / applications * 100, 1) if applications else 0.0,
                "sample_warning": "too few applications to be meaningful" if applications < 10 else None,
            }
        )

    return sorted(results, key=lambda r: r["applications"], reverse=True)
