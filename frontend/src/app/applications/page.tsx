"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { BarChart, ChartFrame, StatTile } from "@/components/Charts";
import { api, Application, FunnelResponse, GmailStatus, ResumePerformance, ResumeVersion } from "@/lib/api";

const STATUS_LABEL: Record<string, string> = {
  applied: "Applied",
  recruiter_outreach: "Recruiter reached out",
  interview_invite: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

const STATUS_STYLE: Record<string, string> = {
  applied: "bg-[var(--surface-sunken)] text-[var(--text-secondary)]",
  recruiter_outreach: "bg-[var(--surface-sunken)] text-[var(--text-secondary)]",
  interview_invite: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  offer: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export default function ApplicationsPage() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [performance, setPerformance] = useState<ResumePerformance[]>([]);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Manual entry. The Gmail sync creates these automatically, but a manual path is
  // essential: inbox classification will never catch every application, and the page
  // previously TOLD the user to "add one manually" with no way to do it.
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ company: "", role: "", status: "applied", resume_version: "" });
  // Real resume versions, so the A/B field is a CHOICE not free text. Typed labels split
  // the stats silently — "v1-spark" and "v1 spark" would look like two different resumes
  // and each would show half the true sample size.
  const [resumeVersions, setResumeVersions] = useState<ResumeVersion[]>([]);

  const load = useCallback(() => {
    api.listApplications().then(setApplications).catch(() => {});
    api.funnel().then(setFunnel).catch(() => {});
    api.resumePerformance().then(setPerformance).catch(() => {});
    api.gmailStatus().then(setGmail).catch(() => {});
    api.listResumeVersions().then(setResumeVersions).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    if (new URLSearchParams(window.location.search).get("gmail") === "connected") {
      setMessage("Gmail connected. Run a sync to import your applications.");
    }
  }, [load]);

  async function connectGmail() {
    try {
      const { authorization_url } = await api.gmailConnect();
      window.location.href = authorization_url;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not start Google sign-in");
    }
  }

  async function disconnectGmail() {
    try {
      await api.gmailDisconnect();
      setMessage("Gmail disconnected.");
      load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not disconnect Gmail");
    }
  }

  async function addApplication(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company.trim()) return;
    try {
      await api.createApplication({
        company: form.company.trim(),
        role: form.role.trim() || undefined,
        status: form.status,
        resume_version: form.resume_version.trim() || undefined,
      });
      setForm({ company: "", role: "", status: "applied", resume_version: "" });
      setAdding(false);
      load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not add application");
    }
  }

  async function changeStatus(id: string, status: string) {
    try {
      await api.updateApplication(id, { status });
      load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not update status");
    }
  }

  async function runSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const { task_id } = await api.syncInbox();
      setMessage("Syncing your inbox… this takes ~30–60 seconds.");

      // Poll every 3 seconds until the Celery task finishes, then refresh.
      // The one-shot 6s timeout was too short — the sync takes ~10s+ with LLM calls.
      await new Promise<void>((resolve) => {
        const interval = setInterval(async () => {
          try {
            const result = await api.syncStatus(task_id);
            if (result.status === "completed") {
              clearInterval(interval);
              const count = result.count ?? 0;
              setMessage(count > 0 ? `Sync done — ${count} new application(s) added.` : "Sync done — no new job emails found in the last 30 days.");
              load();
              resolve();
            } else if (result.status === "failed") {
              clearInterval(interval);
              setMessage(`Sync failed: ${result.error ?? "unknown error"}`);
              resolve();
            }
            // status = "queued" or "running" → keep waiting
          } catch {
            // network blip — keep polling, don't abort
          }
        }, 3000);
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }


  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Applications</h1>
          <p className="mt-1 text-base text-[var(--text-muted)]">
            Connect Gmail and an AI agent reads your inbox, classifies each message, and
            builds this funnel automatically.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAdding((v) => !v)}
            className="rounded border border-[var(--border-strong)] px-4 py-1.5 text-sm hover:bg-[var(--surface-page)] dark:hover:bg-zinc-800"
          >
            {adding ? "Cancel" : "+ Add application"}
          </button>
          {gmail?.connected ? (
            <>
              <span className="text-xs text-[var(--text-muted)]">{gmail.google_email}</span>
              <button
                onClick={runSync}
                disabled={syncing}
                className="rounded bg-zinc-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-[var(--surface-card)] dark:text-[var(--text-primary)]"
              >
                {syncing ? "Syncing…" : "Sync inbox"}
              </button>
              <button
                onClick={disconnectGmail}
                disabled={syncing}
                className="rounded border border-[var(--border-strong)] px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-page)] disabled:opacity-50 dark:hover:bg-zinc-800"
              >
                Disconnect
              </button>
            </>
          ) : gmail?.configured ? (
            <button
              onClick={connectGmail}
              className="rounded bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-[var(--surface-card)] dark:text-[var(--text-primary)]"
            >
              Connect Gmail
            </button>
          ) : (
            <span className="max-w-xs text-right text-xs text-[var(--text-muted)]">
              Gmail not configured — add Google OAuth credentials (see docs/CREDENTIALS.md)
            </span>
          )}
        </div>
      </div>

      {message && (
        <div className="mb-5 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300">
          {message}
        </div>
      )}

      {adding && (
        <form
          onSubmit={addApplication}
          className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4"
        >
          <label className="flex flex-col gap-1 text-sm text-[var(--text-muted)]">
            Company *
            <input
              required
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
              placeholder="Acme Corp"
              className="w-44 rounded border border-[var(--border-strong)] px-3 py-2 text-[15px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-muted)]">
            Role
            <input
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              placeholder="Data Engineer"
              className="w-44 rounded border border-[var(--border-strong)] px-3 py-2 text-[15px]"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-muted)]">
            Status
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className="w-40 rounded border border-[var(--border-strong)] px-3 py-2 text-[15px]"
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-[var(--text-muted)]">
            Resume sent
            <span className="text-[10px] text-[var(--text-muted)]">optional — lets you compare reply rates</span>
            <select
              value={form.resume_version}
              onChange={(e) => setForm({ ...form, resume_version: e.target.value })}
              className="w-48 rounded border border-[var(--border-strong)] px-3 py-2 text-[15px]"
            >
              <option value="">Not tracked</option>
              {resumeVersions.map((v) => (
                <option key={v.id} value={v.label}>
                  {v.label}{v.is_active ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded bg-zinc-900 px-4 py-1.5 text-sm text-white dark:bg-[var(--surface-card)] dark:text-[var(--text-primary)]"
          >
            Add
          </button>
        </form>
      )}

      {funnel && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Applications" value={String(funnel.total_applications)} hint="total sent" />
          <StatTile
            label="Interviews reached"
            value={String(funnel.stages.find((s) => s.stage === "interview_invite")?.count ?? 0)}
            hint="ever — includes later rejections"
          />
          <StatTile
            label="Offers reached"
            value={String(funnel.stages.find((s) => s.stage === "offer")?.count ?? 0)}
            hint="ever — includes ones you declined"
          />
          <StatTile
            label="Rejected"
            value={String(funnel.rejected)}
            hint="current status"
          />
        </div>
      )}

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {funnel && funnel.total_applications > 0 && (
          <ChartFrame
            title="Application funnel — how far you got"
            subtitle="Cumulative history: once an application REACHES a stage it stays counted, even if it was rejected later. That's the point — it measures how far you got, not where things ended up."
            columns={["Stage", "Count", "% of applied"]}
            rows={funnel.stages.map((s) => [
              STATUS_LABEL[s.stage] ?? s.stage,
              s.count,
              `${s.percent_of_applied}%`,
            ])}
          >
            <BarChart
              data={funnel.stages.map((s) => ({
                label: STATUS_LABEL[s.stage] ?? s.stage,
                value: s.count,
              }))}
            />
          </ChartFrame>
        )}

        {performance.length > 0 && (
          <ChartFrame
            title="Resume version performance"
            subtitle="Response rate per resume version — check the sample size before believing it"
            columns={["Version", "Applications", "Responses", "Rate"]}
            rows={performance.map((p) => [
              p.resume_version,
              p.applications,
              p.positive_responses,
              `${p.response_rate_percent}%${p.sample_warning ? " ⚠" : ""}`,
            ])}
          >
            <BarChart
              data={performance.map((p) => ({
                label: p.resume_version,
                value: p.response_rate_percent,
              }))}
              format={(v) => `${v}%`}
            />
          </ChartFrame>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)]">
        <table className="w-full text-left text-[15px]">
          <thead className="border-b border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
            <tr>
              <th className="px-4 py-2.5 font-medium">Company</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Resume</th>
              <th className="px-4 py-2.5 font-medium">Source</th>
              <th className="px-4 py-2.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {applications.map((app) => (
              <tr
                key={app.id}
                className="border-b border-[var(--border-subtle)] last:border-0/60"
              >
                <td className="px-4 py-2.5 font-medium text-[var(--text-primary)]">{app.company}</td>
                <td className="px-4 py-2.5 text-[var(--text-secondary)]">{app.role ?? "—"}</td>
                <td className="px-4 py-2">
                  {/* Editable inline: moving an application forward is the single most
                      common action on this page, so it shouldn't need a detail view. */}
                  <select
                    value={app.status}
                    onChange={(e) => changeStatus(app.id, e.target.value)}
                    className={`cursor-pointer rounded border-0 px-2 py-0.5 text-xs ${STATUS_STYLE[app.status] ?? ""}`}
                  >
                    {Object.entries(STATUS_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                  {app.resume_version ?? "—"}
                </td>
                <td className="px-4 py-2.5 text-[var(--text-muted)]">{app.source}</td>
                <td className="px-4 py-2.5 text-[var(--text-muted)]">
                  {new Date(app.updated_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {!applications.length && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">
                  No applications yet. Connect Gmail and run a sync, or add one manually.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
