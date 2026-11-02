import { handle, ok } from "@/server/http";
import { countUsers } from "@/server/repo/users";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => ok({ needsSetup: countUsers() === 0 }));
}
