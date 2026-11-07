import { NextResponse } from "next/server";
import { getTeams, createTeam } from "@/lib/db/repos/teamsRepo.js";

export async function GET() {
  try {
    const teams = await getTeams();
    return NextResponse.json({ teams });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body?.name?.trim()) {
      return NextResponse.json({ error: "Team name is required" }, { status: 400 });
    }
    const team = await createTeam(body);
    return NextResponse.json({ team }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
