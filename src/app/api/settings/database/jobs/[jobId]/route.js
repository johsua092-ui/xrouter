import { NextResponse } from "next/server";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { verifyPollToken, PASSWORD_HEADER } from "@/lib/db/importJobAuth.js";
import { getImportJob } from "@/lib/db/importJobs";

const CLI_TOKEN_HEADER = "x-9r-cli-token";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

export async function GET(request, context) {
  try {
    // Next.js 16 hands route handlers `params` as a Promise. Reading it
    // synchronously yielded undefined, so every job poll answered 400 "Missing
    // job id" and the dashboard never saw a backup/restore job again.
    const { jobId } = await context.params;
    if (!jobId) {
      return NextResponse.json({ error: "Missing job id" }, { status: 400 });
    }

    const job = getImportJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // The poll credential issued when this job was created is checked first.
    // Password auth stays as a fallback for CLI callers and for jobs created
    // before the token existed, but it must not be the primary path: the
    // import replaces the very settings row that stores the password hash, so
    // comparing against it mid-import 401s an already-authenticated poll.
    const pollToken = request.headers.get("x-9r-poll-token") || "";
    const authorized = isCliRequest(request)
      || verifyPollToken(job, pollToken)
      || (await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)));
    if (!authorized) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const response = {
      status: job.status,
      progress: job.progress?.percent ?? 0,
      section: job.progress?.currentSection || null,
      message: job.message || null,
    };
    if (job.status === "error") {
      response.error = job.error || "Failed to import database";
    }
    return NextResponse.json(response);
  } catch (error) {
    console.log("Error reading database import job:", error);
    return NextResponse.json({ error: "Failed to read import job" }, { status: 500 });
  }
}
