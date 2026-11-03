import { NextResponse } from "next/server";
import { requireUser } from '@/server/authz';

export async function GET(req: Request) {
      await requireUser(req); // phase-2 authz
return NextResponse.json({ message: "Hello, world!" });
}