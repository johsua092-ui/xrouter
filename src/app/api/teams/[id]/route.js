import { NextResponse } from "next/server";
import { getTeamById, updateTeam, deleteTeam } from "@/lib/db/repos/teamsRepo.js";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const team = await getTeamById(id);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    return NextResponse.json({ team });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updated = await updateTeam(id, body);
    if (!updated) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    return NextResponse.json({ team: updated });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    await deleteTeam(id);
    return NextResponse.json({ success: true, id });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
